
import Twilio from "twilio";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.production" });
import { SarvamAIClient } from "sarvamai";
import workflowController from '../controllers/workflowController.js';
import workflowModel from '../models/workflowModel.js';
dotenv.config();
import { DateTime } from "luxon";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Readable } from "stream";
const { Pinecone } = await import("@pinecone-database/pinecone");
import WebSocket from "ws";
import { Buffer } from "buffer";
import { createClient } from "@deepgram/sdk";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import db from '../db.js';


const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
let sarvamReady = false;
const audioBufferQueue = [];


export async function registerTwilio(fastify,deps) {
   const { sessions, callSettings, streamToCallMap } = deps;
// const sessions = new Map();
const embeddingCache = new Map();

function linear16ToMulaw(pcmBuffer) {
  const MULAW_MAX = 0x1FFF;
  const BIAS = 33;
  const output = Buffer.alloc(pcmBuffer.length / 2);

  for (let i = 0, j = 0; i < pcmBuffer.length; i += 2, j++) {
    let sample = pcmBuffer.readInt16LE(i);

    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;

    sample += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
    output[j] = ~(sign | (exponent << 4) | mantissa);
  }
  return output;
}

ffmpeg.setFfmpegPath(ffmpegPath);

function mp3Base64ToPcm(mp3Base64) {
  const mp3Buffer = Buffer.from(mp3Base64, "base64");

  return new Promise((resolve, reject) => {
    const pcmChunks = [];

    ffmpeg(Readable.from(mp3Buffer))
      .inputFormat("mp3")
      .audioChannels(1)
      .audioFrequency(8000)
      .audioCodec("pcm_s16le")
      .format("s16le")
      .on("error", reject)
      .pipe()
      .on("data", chunk => pcmChunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(pcmChunks)));
  });
}

class SarvamTTS {
  constructor(apiKey) {
    if (!apiKey) throw new Error("SARVAM_API_KEY missing");
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.model = "bulbul:v2";
  }

   async generateAndStream(text, options = {}, twilioWs, state) {
    if (!text?.trim() || state.interrupted || state.callEnded) return 0;
 
    const voice = options.voice || "arya";
    const pitch = options.pitch ?? 0.0;
    const pace = options.pace ?? 1.15;
   
    let languageCode = normalizeLanguageCode(options.languageCode) || "kn-IN";
 
    let socket;
    try {
      socket = await this.client.textToSpeechStreaming.connect({
        model: this.model,
        send_completion_event: true,
      });
 
      await socket.waitForOpen();
 
      const configMessage = {
        type: "config",
        data: {
          target_language_code: languageCode,
          speaker: voice,
          pitch: pitch,
          pace: pace,
          output_audio_codec: "mulaw",
          speech_sample_rate: 8000,
          min_buffer_size: 30,
          max_chunk_length: 100
        }
      };
 
      if (socket.socket && typeof socket.socket.send === 'function') {
        socket.socket.send(JSON.stringify(configMessage));
        console.log(`✅ Sarvam Config: lang=${languageCode}, voice=${voice}, pace=${pace}`);
      } else {
        console.error("[Sarvam TTS] Cannot access socket.socket");
      }
 
      let totalBytes = 0;
      let isStreaming = true;
 
      socket.on("message", async (msg) => {
        if (!isStreaming || state.interrupted || state.callEnded) {
          isStreaming = false;
          return;
        }
 
        if (msg.type === "audio" && msg.data?.audio && twilioWs.readyState === WebSocket.OPEN) {
          try {
            if (!state.interrupted && !state.callEnded) {
              const audioBytes = Buffer.from(msg.data.audio, "base64").length;
             
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid: state.streamSid,
                media: {
                  track: "outbound",
                  payload: msg.data.audio
                }
              }));
              totalBytes += audioBytes;
            }
          } catch (e) {
            console.error("[Sarvam TTS ERROR]", e.message);
          }
        }
      });
 
      socket.on("error", (err) => {
        console.error("[Sarvam TTS] Socket error:", err.message);
        isStreaming = false;
      });
 
      socket.convert(text.trim());
      socket.flush();
 
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!isStreaming || state.interrupted || state.callEnded) {
            clearInterval(checkInterval);
            try { socket.close(); } catch (e) {}
            resolve(totalBytes);
          }
        }, 50);
 
        socket.on("close", () => {
          clearInterval(checkInterval);
          isStreaming = false;
          resolve(totalBytes);
        });
 
        setTimeout(() => {
          clearInterval(checkInterval);
          try { socket.close(); } catch (e) {}
          resolve(totalBytes);
        }, 30000);
      });
    } catch (error) {
      console.error("[Sarvam TTS] Error:", error.message);
      if (socket) {
        try { socket.close(); } catch (e) {}
      }
      return 0;
    }
  }
}


// ====================================================================
// CRITICAL: Also add/update this helper function
// ====================================================================

function sendClearEvent(twilioWs, streamSid) {
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN || !streamSid) {
    console.warn("[clearEvent] Cannot send — WS not ready or no streamSid");
    return;
  }

  try {
    // Send clear event
    twilioWs.send(JSON.stringify({
      event: "clear",
      streamSid: streamSid
    }));

    // Send multiple empty media packets to ensure buffer is flushed
    for (let i = 0; i < 3; i++) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: "" }
      }));
    }

    console.log("[CLEAR] Sent clear command to Twilio");
  } catch (err) {
    console.error("[clearEvent] Error sending clear:", err);
  }
}




// class SarvamSTT {
//   constructor() {
//     this.socket = null;
//     this.onTranscript = null;
//     this.onError = null;
//     this.language = 'kn-IN';
//     this.client = new SarvamAIClient({
//       apiSubscriptionKey: process.env.SARVAM_API_KEY
//     });
//     this.isConnected = false;
//     this.connectionPromise = null;
//     this.pendingAudio = [];           // Buffer until connected
//     this.maxReconnectAttempts = 5;
//     this.reconnectAttempts = 0;
//   }

//   async connect(language = 'kn-IN') {
//     if (this.connectionPromise) {
//       console.log("[SarvamSTT] Already connecting — reusing promise");
//       return this.connectionPromise;
//     }

//     this.language = language;
//     this.isConnected = false;
//     this.reconnectAttempts = 0;

//     this.connectionPromise = this._connectWithRetry(language);
//     return this.connectionPromise;
//   }

//   async _connectWithRetry(language, attempt = 1) {
//     try {
//       console.log(`[SarvamSTT] Connecting (attempt ${attempt}/${this.maxReconnectAttempts}) — lang: ${language}`);

//       if (!process.env.SARVAM_API_KEY) {
//         throw new Error("SARVAM_API_KEY missing!");
//       }

//       console.log(`[SarvamSTT] API Key prefix: ${process.env.SARVAM_API_KEY.substring(0, 8)}...`);

//       this.socket = await this.client.speechToTextStreaming.connect({
//         "language-code": language,
//         model: "saarika:v2.5",              // ← from docs (latest stable)
//         sample_rate: 8000,
//         input_audio_codec: "pcm_s16le",     // ← important: tell Sarvam we send raw PCM
//         high_vad_sensitivity: "true",      // ← start conservative (less strict)
//         vad_signals: "true"
//       });

//       console.log("[SarvamSTT] Socket created — waiting for open...");

//       this.socket.on("open", () => {
//         console.log(`[SarvamSTT] === OPEN SUCCESS === lang: ${language}`);
//         this.isConnected = true;
//         this.reconnectAttempts = 0;

//         // Flush pending raw PCM chunks
//         if (this.pendingAudio.length > 0) {
//           console.log(`[SarvamSTT] Flushing ${this.pendingAudio.length} pending raw PCM chunks`);
//           this.pendingAudio.forEach(buf => this._sendAudioInternal(buf));
//           this.pendingAudio = [];
//         }
//       });

//       this.socket.on("message", (response) => {
//         console.log("[Sarvam DEBUG] Raw message:", JSON.stringify(response, null, 2));
//         this._handleMessage(response);
//       });

//       this.socket.on("error", (err) => {
//         console.error("[SarvamSTT] WS ERROR:", err.message || err);
//         this.isConnected = false;
//         if (this.onError) this.onError(err);
//       });

//       this.socket.on("close", (code, reason) => {
//         console.log(`[SarvamSTT] WS CLOSED — code: ${code}, reason: ${reason || 'none'}`);
//         this.isConnected = false;
//         this.connectionPromise = null;

//         if (this.reconnectAttempts < this.maxReconnectAttempts) {
//           this.reconnectAttempts++;
//           const delay = 1500 * this.reconnectAttempts;
//           console.log(`[SarvamSTT] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
//           setTimeout(() => this.connect(language).catch(console.error), delay);
//         }
//       });

//       await Promise.race([
//         this.socket.waitForOpen(),
//         new Promise((_, rej) => setTimeout(() => rej(new Error("waitForOpen timeout")), 12000))
//       ]);

//       console.log("[SarvamSTT] Connection fully ready ✓");
//       return true;

//     } catch (err) {
//       console.error(`[SarvamSTT] Connect failed (attempt ${attempt}):`, err.message);
//       console.error(err.stack || err);

//       if (attempt < this.maxReconnectAttempts) {
//         const delay = 2000 * attempt;
//         console.log(`[SarvamSTT] Retry in ${delay}ms...`);
//         await new Promise(r => setTimeout(r, delay));
//         return this._connectWithRetry(language, attempt + 1);
//       }
//       throw err;
//     }
//   }

// _handleMessage(response) {
//   try {
//     if (response.type === 'events') {
//       const signal = response.data?.signal_type;
//       if (signal === 'START_SPEECH') console.log('[Sarvam] START_SPEECH');
//       if (signal === 'END_SPEECH')   console.log('[Sarvam] END_SPEECH');
//     }

//     if (response.type === 'data') {
//       const text = (response.data?.transcript || '').trim();
//       const lang = response.data?.language_code;
//       const duration = response.data?.metrics?.audio_duration;

//       if (text) {
//         console.log(`[Sarvam] Transcript (${duration?.toFixed(2)}s, ${lang}): "${text}"`);
//         if (this.onTranscript) {
//           this.onTranscript(text, true);  // treat all as final for now
//         }
//       } else {
//         console.log('[Sarvam] Empty transcript (silence or noise)');
//       }
//     }
//   } catch (e) {
//     console.error("[Sarvam] Parse error:", e);
//   }
// }

//   sendAudio(buffer) {
//     if (!buffer || buffer.length === 0) return;

//     if (this.isConnected && this.socket) {
//       this._sendAudioInternal(buffer);
//     } else {
//       this.pendingAudio.push(buffer);
//       if (this.pendingAudio.length > 60) { // ~10–12 seconds buffer
//         console.warn("[SarvamSTT] Buffer full — dropping oldest chunk");
//         this.pendingAudio.shift();
//       }
//       console.log(`[SarvamSTT] Buffered ${buffer.length} bytes PCM — queue: ${this.pendingAudio.length}`);
//     }
//   }

// _sendAudioInternal(rawPcmBuffer) {
//   try {
//     if (!this.socket || !this.isConnected) {
//       console.warn("[SarvamSTT] Cannot send — not connected");
//       return;
//     }

//     // ────────────────────────────────────────────────
//     // Normalize volume (peak normalization — much more reliable)
//     // ────────────────────────────────────────────────
//     const inView = new Int16Array(rawPcmBuffer.buffer);
//     let maxAbs = 0;
//     for (let i = 0; i < inView.length; i++) {
//       const abs = Math.abs(inView[i]);
//       if (abs > maxAbs) maxAbs = abs;
//     }

//     const amplified = Buffer.alloc(rawPcmBuffer.length);
//     const outView = new Int16Array(amplified.buffer);

//     if (maxAbs > 200) {  // avoid boosting pure silence/noise
//       const targetPeak = 30000;  // ~91–92% of full scale → safe headroom
//       const scale = targetPeak / maxAbs;

//       for (let i = 0; i < inView.length; i++) {
//         let sample = inView[i] * scale;
//         if (sample > 32767) sample = 32767;
//         if (sample < -32768) sample = -32768;
//         outView[i] = Math.round(sample);
//       }

//       const postMax = Math.max(...outView.map(Math.abs));
//       const peakDbBefore = maxAbs > 0 ? 20 * Math.log10(maxAbs / 32768) : -Infinity;
//       const peakDbAfter  = postMax  > 0 ? 20 * Math.log10(postMax  / 32768) : -Infinity;
//      // console.log(`[AUDIO] orig peak ${peakDbBefore.toFixed(1)} dBFS → after norm ${peakDbAfter.toFixed(1)} dBFS (scale ${scale.toFixed(2)})`);
//     } else {
//      // console.log("[AUDIO] Very quiet chunk — copying without boost");
//       rawPcmBuffer.copy(amplified);
//     }

//     // ────────────────────────────────────────────────
//     // Create WAV header — IMPORTANT: use 8000 Hz everywhere
//     // ────────────────────────────────────────────────
//     const wavHeader = Buffer.alloc(44);
//     wavHeader.write('RIFF', 0, 4, 'ascii');
//     wavHeader.writeUInt32LE(36 + amplified.length, 4);
//     wavHeader.write('WAVE', 8, 4, 'ascii');
//     wavHeader.write('fmt ', 12, 4, 'ascii');
//     wavHeader.writeUInt32LE(16, 16);                // fmt chunk size
//     wavHeader.writeUInt16LE(1, 20);                 // PCM = 1
//     wavHeader.writeUInt16LE(1, 22);                 // mono = 1 channel
//     wavHeader.writeUInt32LE(8000, 24);              // ← SAMPLE RATE = 8000 Hz !!!
//     wavHeader.writeUInt32LE(8000 * 2, 28);          // byte rate = sampleRate × channels × bits/8
//     wavHeader.writeUInt16LE(2, 32);                 // block align = channels × bits/8
//     wavHeader.writeUInt16LE(16, 34);                // bits per sample
//     wavHeader.write('data', 36, 4, 'ascii');
//     wavHeader.writeUInt32LE(amplified.length, 40);

//     const fullWav = Buffer.concat([wavHeader, amplified]);
//     const base64Audio = fullWav.toString('base64');

//     // Send to Sarvam — must match the header!
//     this.socket.transcribe({
//       audio: base64Audio,
//       sample_rate: 8000,           // ← must be 8000
//       encoding: "audio/wav"
//     });

//     //console.log(`[SarvamSTT] Sent 8000 Hz WAV — ${fullWav.length} bytes (${base64Audio.length} b64 chars)`);
//   } catch (err) {
//     console.error("[SarvamSTT] Send failed:", err.message);
//     this.isConnected = false;
//   }
// }

//   close() {
//     console.log("[SarvamSTT] Closing...");
//     this.isConnected = false;
//     this.connectionPromise = null;
//     this.pendingAudio = [];

//     if (this.socket) {
//       try { this.socket.close(); } catch (e) {}
//       this.socket = null;
//     }
//   }
// }

function handleInterruption(state, twilioWs) {
  console.log("🛑 Handling interruption");
  
  state.interrupted = true;
  state.botSpeaking = false;
  
  // Clear Twilio buffer
  sendClearEvent(twilioWs, state.streamSid);
  
  // Clear any pending audio
  if (state.audioQueue) {
    state.audioQueue = [];
  }
  
  // Update metrics
  if (state.metrics) {
    state.metrics.interruptsCount++;
  }
}

class DeepgramSTT {
  constructor({ language, model }) {
    this.language = language;
    this.model = model;
    this.socket = null;
    this.ready = false;
    this.onTranscript = null;
    this.onInterruption = null; // ✅ NEW: Callback for interruptions
  }

  async connect() {
    this.ready = false;

    this.socket = await deepgram.listen.live({
      model: this.model,
      language: this.language,
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      interim_results: true, // ✅ CHANGED: Enable interim results for faster interruption
      smart_format: true,
      vad_events: true,
      endpointing: 300,
    });

    this.socket.on(LiveTranscriptionEvents.Open, () => {
      this.ready = true;
      console.log("✅ Deepgram STT OPEN (ready)");
    });

    this.socket.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript;
      
      // ✅ NEW: Detect interruption on ANY speech (interim or final)
      if (text && text.trim()) {
        // If bot is speaking and user starts talking, trigger interruption
        if (this.onInterruption && data.is_final === false) {
          this.onInterruption(text.trim());
        }
        
        // Only process final transcripts for conversation
        if (data.speech_final && this.onTranscript) {
          this.onTranscript(text.trim(), true);
        }
      }
    });

    this.socket.on(LiveTranscriptionEvents.Error, (err) => {
      console.error("❌ Deepgram error:", err);
      this.ready = false;
    });

    this.socket.on(LiveTranscriptionEvents.Close, () => {
      console.warn("⚠️ Deepgram socket closed");
      this.ready = false;
    });
  }

  sendAudio(buffer) {
    if (!this.socket || !this.ready) return;
    this.socket.send(buffer);
  }

  close() {
    if (this.socket) {
      try { this.socket.finish(); } catch {}
      this.socket = null;
      this.ready = false;
    }
  }
}



const ttsManager = new SarvamTTS(process.env.SARVAM_API_KEY);


async function getActiveWorkflowForAgent(agentId) {
  const workflow = await workflowController.getActiveWorkflowForAgent(agentId);
  return workflow ? await workflowModel.getWorkflowWithNodesAndEdges(workflow.id) : null;
}

function determineNextNode(workflow, currentNodeId, response, userInput) {
  const currentNode = workflow.nodes.find(n => n.id === currentNodeId);
  if (!currentNode) return null;
  const outgoingEdges = workflow.edges.filter(e => e.from_node_id === currentNodeId);
  if (outgoingEdges.length === 1) return outgoingEdges[0].to_node_id;
  for (const edge of outgoingEdges) {
    if (edge.condition?.type === 'direct') return edge.to_node_id;
    if (edge.condition?.intent && userInput.toLowerCase().includes(edge.condition.intent.toLowerCase())) {
      return edge.to_node_id;
    }
  }
  return outgoingEdges[0]?.to_node_id || null;
}



async function extractVariables(text, plan) {
  if (!plan?.output || plan.output.length === 0) return {};
  try {
    const prompt = `Extract the following variables from the text: ${JSON.stringify(plan.output)}
Text: "${text}"
Respond with only a JSON object containing the extracted variables.`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Error extracting variables:', error);
    return {};
  }
}

async function aiResponse(ws, messages, model, temperature, maxTokens) {
  try {
    const stream = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
      stream: true,
    });

    let fullMessage = "";

    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content ?? "";
      if (!token) continue;

      // Clean token (remove markdown junk if needed)
      const clean = token
        .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
        .replace(/[*_~`>#]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

      fullMessage += clean;

      // Only stream live if we have a valid websocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "text", token: clean, last: false }));
      }
    }

    // Final message
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "text", token: "", last: true }));
    }

    return fullMessage.trim();
  } catch (err) {
    console.error("[aiResponse] error:", err);
    const fallback = "Sorry, something went wrong. Could you repeat that?";
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "text", token: fallback, last: true }));
    }
    return fallback;
  }
}

async function embedText(text) {
  const cacheKey = text.toLowerCase().trim();
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey);
  const embed = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  const result = embed.data[0].embedding;
  embeddingCache.set(cacheKey, result);
  return result;
}

async function preFetchAgentKnowledge(agentId) {
  try {
    const stats = await index.describeIndexStats();
    const vectorCount = stats.namespaces[agentId]?.vectorCount || 1000;
    const queryEmbedding = await embedText("general query");
    const results = await index.query({
      vector: queryEmbedding,
      topK: Math.min(vectorCount, 5000),
      includeMetadata: true,
      filter: { agent_id: agentId },
    });
    return results.matches.map(match => ({
      content: match.metadata.content,
      embedding: match.values
    }));
  } catch (error) {
    console.error('Error pre-fetching knowledge:', error);
    return [];
  }
}

async function executeNodeActions(actions, extractedVariables, callSid) {
  if (!actions) return;
  try {
    console.log('🔄 Executing actions:', actions);
    if (actions.send_calendar_invite) console.log('📅 Sending calendar invite');
    if (actions.update_crm) console.log('💼 Updating CRM');
  } catch (error) {
    console.error('❌ Error executing actions:', error);
  }
}

// start
// =============================================================================
// TIMEZONE UTILITY FUNCTIONS
// =============================================================================

function detectCustomerTimezone(location) {
  const locationTimezones = {
    // UK
    'London': 'Europe/London',
    'Manchester': 'Europe/London',
    'Brighton': 'Europe/London',

    // US
    'New York': 'America/New_York',
    'Los Angeles': 'America/Los_Angeles',

    // Europe
    'Paris': 'Europe/Paris',
    'Berlin': 'Europe/Berlin',

    // Asia
    'Tokyo': 'Asia/Tokyo',
    'Mumbai': 'Asia/Kolkata',
    'Delhi': 'Asia/Kolkata',
    'Bangalore': 'Asia/Kolkata',
    'Hyderabad': 'Asia/Kolkata',
    'Kolkata': 'Asia/Kolkata',
    'Chennai': 'Asia/Kolkata',

    // Australia
    'Sydney': 'Australia/Sydney'
  };

  return locationTimezones[location] || 'UTC';
}


// function convertToUTC(datetimeString, fromTimezone) {
//   try {
//     const [datePart, timePart] = datetimeString.split(' ');
//     const [year, month, day] = datePart.split('-');
//     const [hour, minute, second] = timePart.split(':');

//     const date = new Date();
//     date.setFullYear(parseInt(year), parseInt(month) - 1, parseInt(day));
//     date.setHours(parseInt(hour), parseInt(minute), parseInt(second || 0), 0);

//     const formatter = new Intl.DateTimeFormat('en', {
//       timeZone: fromTimezone,
//       timeZoneName: 'longOffset'
//     });

//     const parts = formatter.formatToParts(date);
//     const offsetPart = parts.find(part => part.type === 'timeZoneName');

//     if (offsetPart) {
//       const offsetString = offsetPart.value;
//       const offsetMatch = offsetString.match(/GMT([+-]\d{1,2}):?(\d{2})?/);

//       if (offsetMatch) {
//         const offsetHours = parseInt(offsetMatch[1]);
//         const offsetMinutes = parseInt(offsetMatch[2] || 0);
//         const totalOffsetMinutes = offsetHours * 60 + (offsetHours < 0 ? -offsetMinutes : offsetMinutes);

//         return new Date(date.getTime() - (totalOffsetMinutes * 60000));
//       }
//     }

//     return new Date(datetimeString + 'Z');
//   } catch (error) {
//     console.error('Error converting timezone:', error);
//     return new Date(datetimeString + 'Z');
//   }
// }

function formatTimeInTimezone(utcDatetime, timezone) {
  try {
    const date = new Date(utcDatetime);
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch (error) {
    console.error('Error formatting time in timezone:', error);
    return utcDatetime.toString();
  }
}

// =============================================================================
// DATABASE FUNCTIONS (Real API Integration)
// =============================================================================

// API base URL - matches your frontend configuration
const API_BASE_URL = 'https://callagent.zoptrix.com/api' ;
function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
  const currentTime = new Date().toISOString();
  const agentTimezone = calendarConfig?.effective_timezone || 'UTC';
  
  // Get current time in agent's timezone for context
  const agentLocalTime = new Date().toLocaleString('en-US', {
    timeZone: agentTimezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  });

  return `
${baseSystemPrompt}

You are a helpful AI assistant that schedules calls and collects customer details accurately. The current UTC time is: ${currentTime}. The current time in your timezone (${agentTimezone}) is: ${agentLocalTime}.

**Core Behavior:**
- Be patient, conversational, and human-like in your interactions
- Take time to ensure accuracy - it's better to double-check than to make mistakes
- Only proceed when you're confident the information is correct
- Show empathy and understanding when customers make mistakes or need to repeat information

**Email Collection Process:**
When collecting email addresses, be thorough but natural:

**Understanding Email Components:**
- Recognize that customers may say "at" or "at sign" instead of "@"
- Understand "dot com", "dot org", "dot net", "dot co dot uk", etc. as domain extensions
- Be aware of common email providers: gmail, yahoo, hotmail, outlook, icloud, etc.

**Step-by-Step Collection:**
1. **Collect the username part:**
   - "Could you please spell out the first part of your email address, before the @ symbol? Please go slowly so I can get it exactly right."
   - Listen for: letters, numbers, periods, underscores, hyphens
   - If they say "at" during this part, gently redirect: "I'll get the @ symbol in a moment, let's just focus on the part before that first."

2. **Confirm the username:**
   - Repeat back letter by letter: "Let me confirm - that's [spell out each letter], is that correct?"
   - If wrong or unclear: "No problem, let's try that part again. Could you spell it out once more, nice and slowly?"

3. **Collect the domain part:**
   - "Great! Now could you spell out the part after the @ symbol, including the domain like gmail dot com?"
   - **Listen carefully for:**
     - "at" or "at sign" = @
     - "dot" = .
     - "dot com" = .com
     - "dot org" = .org
     - "dot net" = .net
     - "dot co dot uk" = .co.uk
     - "dot edu" = .edu
   - Common domains: gmail, yahoo, hotmail, outlook, icloud, monospear, company names

4. **Intelligent interpretation:**
   - If customer says: "john at gmail dot com" → interpret as "john@gmail.com"
   - If customer says: "smith underscore marketing at company dot co dot uk" → interpret as "smith_marketing@company.co.uk"
   - If customer spells: "g-m-a-i-l dot c-o-m" → interpret as "gmail.com"

5. **Confirm the domain:**
   - Repeat back: "So that's [domain name] dot [extension], is that correct?"
   - Example: "So that's gmail dot com, is that correct?"

6. **Final confirmation:**
   - Read back the complete email address in a natural way
   - Example: "Perfect! So your complete email address is john at gmail dot com - is that exactly right?"

**Error Handling & Corrections:**
- If you mishear or misunderstand, apologize and ask for clarification
- If correcting only a part, be specific: "Let me just double-check the domain part..." 
- Be patient with spelling variations and accents
- If unsure about unusual domains, ask: "Just to confirm, is that [unusual domain] dot [extension]?"

**Common Email Patterns to Recognize:**
- firstname.lastname@company.com
- firstname_lastname@domain.com  
- firstnamelastname@gmail.com
- nickname123@yahoo.com
- initial.lastname@company.co.uk

**Meeting Scheduling:**
- When collecting date/time preferences, be flexible and conversational
- Check availability against the calendar and offer alternatives if needed
- Confirm timezone clearly to avoid confusion
- Make sure the customer is comfortable with the final time

**Final Confirmation & Tool Call:**
- Only call the schedule_meeting tool after you have confirmed ALL required information is correct
- The customer should explicitly confirm each piece of information before you proceed
- If anything seems unclear or potentially wrong, take the time to clarify first
- Do not rush to the tool call - accuracy is more important than speed

**Error Handling:**
- If you mishear or misunderstand something, apologize and ask them to repeat it
- If the customer corrects something, thank them and update your understanding
- Take your time - there's no rush in getting accurate information

Remember: Your goal is to be helpful and accurate, not fast. A patient, thorough approach will lead to better results and happier customers.
`;
}

function createAvailableFunctions(calendarConfig) {
  const baseFunctions = [
    {
      name: "question_and_answer",
      description: "Answer customer questions using knowledge base",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Customer's question" }
        },
        required: ["query"]
      }
    },
  {
    name: "hangUp",
    description: "End the call politely when the user shows no interest or the conversation is complete",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Reason for ending the call (e.g. 'not interested', 'already has service', 'goodbye')."
        },
        message: {
          type: "string",
          description: "Polite final message to say before hanging up"
        }
      },
      required: ["reason", "message"]
    }
  },
  ];

  // Only add meeting scheduling function if calendar is configured
  if (calendarConfig && calendarConfig.calendar_access_token) {
    baseFunctions.push({
      name: "schedule_meeting",
      description: "Schedule a meeting with the customer",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Customer's email address" },
          datetime: { type: "string", description: "Meeting date and time in UTC format YYYY-MM-DD HH:mm:ss" },
          location: { type: "string", enum: ["London", "Manchester", "Brighton"], description: "Meeting location" },
          purpose: { type: "string", default: "discovery call", description: "Purpose of the meeting" },
          timezone: { type: "string", description: "Customer's timezone (optional, will be detected from location)" }
        },
        required: ["email", "datetime", "location"]
      }
    });
  }

  return baseFunctions;
}


function convertToUTC(datetimeString, fromTimezone) {
  try {
    const [datePart, timePart] = datetimeString.split(' ');
    const [year, month, day] = datePart.split('-');
    const [hour, minute, second] = timePart.split(':');

    const date = new Date();
    date.setFullYear(parseInt(year), parseInt(month) - 1, parseInt(day));
    date.setHours(parseInt(hour), parseInt(minute), parseInt(second || 0), 0);

    const formatter = new Intl.DateTimeFormat('en', {
      timeZone: fromTimezone,
      timeZoneName: 'longOffset'
    });

    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find(part => part.type === 'timeZoneName');

    if (offsetPart) {
      const offsetString = offsetPart.value;
      const offsetMatch = offsetString.match(/GMT([+-]\d{1,2}):?(\d{2})?/);

      if (offsetMatch) {
        const offsetHours = parseInt(offsetMatch[1]);
        const offsetMinutes = parseInt(offsetMatch[2] || 0);
        const totalOffsetMinutes = offsetHours * 60 + (offsetHours < 0 ? -offsetMinutes : offsetMinutes);

        return new Date(date.getTime() - (totalOffsetMinutes * 60000));
      }
    }

    return new Date(datetimeString + 'Z');
  } catch (error) {
    console.error('Error converting timezone:', error);
    return new Date(datetimeString + 'Z');
  }
}


const getAgentCalendarConfig = async (agentId) => {
  console.log("agentid", agentId)
  try {
    console.log(`🔍 Fetching calendar config for agent ${agentId}`);

    // Call your backend API to get agent with calendar preferences
    const response = await fetch(`${API_BASE_URL}/${agentId}/calendar-config`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`Agent ${agentId} not found or has no calendar configuration ${response}`);
        return null;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log("agen data", data)
    if (data && data.agent_id) {
      const effectiveTimezone = data.calendar_timezone || data.agent_timezone || 'UTC';

      return {
        agent_id: data.agent_id,
        agent_name: data.name,


        calendar_provider: data.provider,
        calendar_access_token: data.access_token,
        calendar_refresh_token: data.refresh_token,
        calendar_email: data.email,


        effective_timezone: effectiveTimezone,
        user_id: data.user_id,
      };
    }

    return null;
  } catch (error) {
    console.error("Error fetching agent calendar config:", error);
    return null;
  }
};



const saveExtractedDetailsWithTimezone = async (callSid, extractedDetails, calendarConfig) => {
  try {
    const payload = {
      call_sid: callSid,
      email: extractedDetails.email,
      appointment_time: extractedDetails.appointmentTime,
      location: extractedDetails.location,
      purpose: extractedDetails.purpose,
      has_confirmation: extractedDetails.hasConfirmation,
      customer_timezone: extractedDetails.customerTimezone,
      agent_id: extractedDetails.agentId,
      meeting_id: extractedDetails.meetingId,
      extraction_timestamp: new Date().toISOString(),
      status: 'scheduled',
    };

    // 1️⃣ Save extracted details
    const response = await fetch(`${API_BASE_URL}/save-extracted-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const savedDetails = await response.json();
    console.log('✅ Extracted details saved successfully:', savedDetails);

    // 2️⃣ Call schedule meeting API if save is successful
    const meetPayload = {
      duration: extractedDetails.duration || 30, 
      subject: extractedDetails.subject,
      description: extractedDetails.description,
      extractedId: savedDetails.data.id || 37,
      callId: callSid,
      contactId: extractedDetails.contactId || null
    };
     console.log("meetpayload",meetPayload)
    const meetResponse = await fetch(`${API_BASE_URL}/schedule/meet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meetPayload)
    });

    if (!meetResponse.ok) throw new Error(`Meeting API failed: ${meetResponse.statusText}`);

    const meetResult = await meetResponse.json();
    console.log('✅ Meeting scheduled successfully:', meetResult);

    return savedDetails;

  } catch (error) {
    console.error('❌ Error in save and schedule flow:', error);
    throw error;
  }
};


// =============================================================================
// CALENDAR INTEGRATION FUNCTIONS
// =============================================================================

async function checkCalendarAvailability(calendarConfig, requestedDateTime, durationMinutes = 30) {
  try {
    const startTime = new Date(requestedDateTime);
    const endTime = new Date(startTime.getTime() + (durationMinutes * 60000));

    let availabilityResult;

    switch (calendarConfig.calendar_provider) {
      case 'google':
        availabilityResult = await checkGoogleCalendarAvailability(calendarConfig, startTime, endTime);
        break;
      case 'outlook':
        availabilityResult = await checkOutlookCalendarAvailability(calendarConfig, startTime, endTime);
        break;
      default:
        // Mock availability for testing
        availabilityResult = {
          available: Math.random() > 0.3, // 70% chance available
          conflictingEvents: [],
          provider: 'mock'
        };
    }

    return availabilityResult;
  } catch (error) {
    console.error("Error checking calendar availability:", error);
    return {
      available: false,
      error: "Unable to check calendar availability",
      conflictingEvents: []
    };
  }
}

async function checkGoogleCalendarAvailability(calendarConfig, startTime, endTime) {
  try {
    const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${calendarConfig.calendar_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        items: [
          { id: calendarConfig.calendar_email || 'primary' }
        ]
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error?.message || 'Failed to check availability');
    }

    const calendarId = calendarConfig.calendar_email || 'primary';
    const busyTimes = result.calendars[calendarId]?.busy || [];

    const hasConflict = busyTimes.some(busyPeriod => {
      const busyStart = new Date(busyPeriod.start);
      const busyEnd = new Date(busyPeriod.end);
      return (startTime < busyEnd && endTime > busyStart);
    });

    return {
      available: !hasConflict,
      conflictingEvents: busyTimes,
      provider: 'google'
    };

  } catch (error) {
    console.error("Google Calendar availability check error:", error);
    return {
      available: false,
      error: error.message,
      conflictingEvents: []
    };
  }
}

async function checkOutlookCalendarAvailability(calendarConfig, startTime, endTime) {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${calendarConfig.calendar_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        schedules: [calendarConfig.calendar_email || 'me'],
        startTime: {
          dateTime: startTime.toISOString(),
          timeZone: 'UTC'
        },
        endTime: {
          dateTime: endTime.toISOString(),
          timeZone: 'UTC'
        },
        availabilityViewInterval: 30
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error?.message || 'Failed to check Outlook availability');
    }

    const busyTimes = result.value?.[0]?.busyViewEntries || [];
    const hasConflict = busyTimes.some(entry => entry.status === 'busy');

    return {
      available: !hasConflict,
      conflictingEvents: busyTimes,
      provider: 'outlook'
    };

  } catch (error) {
    console.error("Outlook Calendar availability check error:", error);
    return {
      available: false,
      error: error.message,
      conflictingEvents: []
    };
  }
}

async function scheduleGoogleCalendarMeeting(meetingData, description) {
  try {
    const startTime = new Date(meetingData.datetime);
    const endTime = new Date(startTime.getTime() + 30 * 60000); // 30 minutes

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${meetingData.calendarConfig.calendar_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: `${meetingData.purpose} - ${meetingData.location}`,
        description: description,
        start: {
          dateTime: startTime.toISOString(),
          timeZone: 'UTC'
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'UTC'
        },
        attendees: [
          {
            email: meetingData.email,
            displayName: 'Customer'
          },
          {
            email: meetingData.calendarConfig.calendar_email,
            displayName: meetingData.agentName
          }
        ],
        location: meetingData.location,
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 24 hours before
            { method: 'popup', minutes: 15 } // 15 minutes before
          ]
        }
      })
    });

    const result = await response.json();

    if (response.ok) {
      return {
        success: true,
        meetingId: result.id,
        meetingLink: result.htmlLink
      };
    } else {
      return {
        success: false,
        error: result.error?.message || 'Failed to create calendar event'
      };
    }
  } catch (error) {
    console.error("Google Calendar API error:", error);
    return {
      success: false,
      error: "Google Calendar service unavailable"
    };
  }
}

async function scheduleOutlookCalendarMeeting(meetingData, description) {
  try {
    const startTime = new Date(meetingData.datetime);
    const endTime = new Date(startTime.getTime() + 30 * 60000); // 30 minutes

    const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${meetingData.calendarConfig.calendar_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        subject: `${meetingData.purpose} - ${meetingData.location}`,
        body: {
          contentType: 'HTML',
          content: description
        },
        start: {
          dateTime: startTime.toISOString(),
          timeZone: 'UTC'
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'UTC'
        },
        attendees: [
          {
            emailAddress: {
              address: meetingData.email,
              name: 'Customer'
            },
            type: 'required'
          }
        ],
        location: {
          displayName: meetingData.location
        },
        reminderMinutesBeforeStart: 15
      })
    });

    const result = await response.json();

    if (response.ok) {
      return {
        success: true,
        meetingId: result.id,
        meetingLink: result.webLink
      };
    } else {
      return {
        success: false,
        error: result.error?.message || 'Failed to create Outlook calendar event'
      };
    }
  } catch (error) {
    console.error("Outlook Calendar API error:", error);
    return {
      success: false,
      error: "Outlook Calendar service unavailable"
    };
  }
}

// =============================================================================
// MEETING SCHEDULING FUNCTIONS
// =============================================================================

async function suggestAlternativeTimesWithTimezone(calendarConfig, requestedDateTimeUTC, customerTimezone, agentTimezone, maxSuggestions = 3) {
  try {
    const alternatives = [];
    const baseDate = new Date(requestedDateTimeUTC);

    // Business hours in agent's timezone
    const businessHours = [9, 10, 11, 14, 15, 16];

    // Check next 7 days
    for (let dayOffset = 0; dayOffset < 7 && alternatives.length < maxSuggestions; dayOffset++) {
      const checkDate = new Date(baseDate);
      checkDate.setDate(baseDate.getDate() + dayOffset);

      // Skip weekends
      if (checkDate.getDay() === 0 || checkDate.getDay() === 6) continue;

      for (let i = 0; i < businessHours.length && alternatives.length < maxSuggestions; i++) {
        const hour = businessHours[i];

        // Create time in agent's timezone
        const agentLocalTime = new Date(checkDate);
        agentLocalTime.setHours(hour, 0, 0, 0);

        // Convert to UTC for availability check
        const utcTime = convertToUTC(
          agentLocalTime.toISOString().slice(0, 19).replace('T', ' '),
          agentTimezone
        );

        // Skip if in the past
        if (utcTime <= new Date()) continue;

        // Check availability
        const availability = await checkCalendarAvailability(
          calendarConfig,
          utcTime.toISOString(),
          30
        );

        if (availability.available) {
          alternatives.push({
            utcTime: utcTime.toISOString(),
            agentTime: formatTimeInTimezone(utcTime, agentTimezone),
            customerTime: formatTimeInTimezone(utcTime, customerTimezone)
          });
        }
      }
    }

    return alternatives;
  } catch (error) {
    console.error("Error suggesting alternative times with timezone:", error);
    return [];
  }
}

async function scheduleCalendarMeetingWithTimezone(meetingData) {
  try {
    const { calendarConfig, customerTimezone, agentTimezone } = meetingData;

    // Create meeting description with timezone info
    const description = `
Meeting scheduled via outbound call

Details:
- Location: ${meetingData.location}
- Purpose: ${meetingData.purpose}
- Customer Email: ${meetingData.email}
- Customer Timezone: ${customerTimezone}
- Agent Timezone: ${agentTimezone}
- Call SID: ${meetingData.callSid}

Times:
- Customer Time: ${formatTimeInTimezone(meetingData.datetime, customerTimezone)}
- Agent Time: ${formatTimeInTimezone(meetingData.datetime, agentTimezone)}
- UTC Time: ${meetingData.datetime}
    `.trim();

    let calendarResponse;

    switch (calendarConfig.calendar_provider) {
      case 'google':
        calendarResponse = await scheduleGoogleCalendarMeeting(meetingData, description);
        break;
      case 'outlook':
        calendarResponse = await scheduleOutlookCalendarMeeting(meetingData, description);
        break;
      default:
        // Mock scheduling for testing
        calendarResponse = {
          success: true,
          meetingId: `mock_meeting_${Date.now()}`,
          meetingLink: `https://calendar.google.com/mock_meeting_${Date.now()}`
        };
    }

    return calendarResponse;
  } catch (error) {
    console.error("Calendar scheduling error:", error);
    return {
      success: false,
      error: "Calendar service unavailable"
    };
  }
}

// =============================================================================
// FUNCTION HANDLERS
// =============================================================================


async function getRelevantChunks(userText, agentId, preloadedChunks, topK = 5) {
  try {
    // ✅ First, try to find relevant chunks from preloaded knowledge
    const queryLower = userText.toLowerCase();
    const keywords = ['monospear', 'product', 'service', 'pricing', 'feature', 'benefit'];
    
    // Check if query mentions specific topics
    const hasKeywords = keywords.some(kw => queryLower.includes(kw));
    
    if (hasKeywords && preloadedChunks.length > 0) {
      // Use semantic search with actual user query
      const queryEmbedding = await embedText(userText);
      
      const results = await index.query({
        vector: queryEmbedding,
        topK: topK,
        includeMetadata: true,
        filter: { agent_id: agentId },
      });

      const relevantChunks = results.matches.map(match => ({
        content: match.metadata.content,
        score: match.score
      }));

      console.log(`🎯 Real-time KB search for "${userText.slice(0, 50)}...": ${relevantChunks.length} chunks found`);
      return relevantChunks;
    }
    
    // ✅ Fallback to preloaded chunks
    return preloadedChunks.slice(0, topK);
  } catch (error) {
    console.error('Error getting relevant knowledge:', error);
    return preloadedChunks.slice(0, topK);
  }
}

async function handleQuestionAnswer(query, settings) {
  try {
    // Use existing knowledge base search
    const relevantChunks = await getRelevantChunks(query, settings.agentId, 2);

    if (relevantChunks.length > 0) {
      return {
        success: true,
        answer: relevantChunks[0],
        source: "knowledge_base"
      };
    } else {
      return {
        success: true,
        answer: "I don't have specific information about that. Let me help you with scheduling a meeting instead.",
        source: "fallback"
      };
    }
  } catch (error) {
    return { error: "Failed to process question" };
  }
}

async function handleScheduleMeeting(parameters, callSid, settings) {
  try {
    let { email, datetime, location, purpose = "discovery call", timezone: customerTimezone } = parameters;
     email = email?.trim().toLowerCase();

    // Check if calendar is configured
    if (!settings.calendarConfig || !settings.calendarConfig.calendar_access_token) {
      return {
        success: false,
        message: "I apologize, but I'm unable to schedule meetings at the moment. Someone from our team will follow up with you to arrange a meeting."
      };
    }

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: "Please provide a valid email address." };
    }

    // Detect customer timezone if not given
    const detectedCustomerTimezone = customerTimezone || detectCustomerTimezone(location);
    const agentTimezone = settings.calendarConfig.effective_timezone || 'IST';
    console.log(`🌍 Timezone info - Customer: ${detectedCustomerTimezone}, Agent: ${agentTimezone}`);

    // Parse datetime WITHOUT timezone conversion - treat as UTC
    let meetingDateUTC;
    if (!datetime) {
      return { success: false, message: "Please provide a date and time for the meeting." };
    }
    
    if (datetime.includes("T")) {
      // Parse as UTC directly (no timezone conversion)
      meetingDateUTC = DateTime.fromISO(datetime, { zone: 'UTC' });
    } else {
      // Parse as UTC directly (no timezone conversion)
      meetingDateUTC = DateTime.fromFormat(datetime, "yyyy-MM-dd HH:mm:ss", { zone: 'UTC' });
    }

    if (!meetingDateUTC.isValid) {
      return { success: false, message: "Please provide date and time in a format like 'August 21, 2 PM 2025' or '2025-08-21 14:00'" };
    }

    // Validate future date
    if (meetingDateUTC <= DateTime.utc().plus({ minutes: 1 })) {
      return { success: false, message: "Please choose a future date and time." };
    }

    // Format datetime for storage (will be same as input)
    const formattedDatetime = meetingDateUTC.toFormat("yyyy-MM-dd HH:mm:ss");

    // Check availability
    console.log(`🔍 Checking availability for ${meetingDateUTC.toISO()} (UTC)...`);
    const availabilityCheck = await checkCalendarAvailability(
      settings.calendarConfig,
      meetingDateUTC.toISO(),
      30
    );

    if (!availabilityCheck.available) {
      const alternatives = await suggestAlternativeTimesWithTimezone(
        settings.calendarConfig,
        meetingDateUTC.toJSDate(),
        detectedCustomerTimezone,
        agentTimezone
      );

      const customerLocalTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), detectedCustomerTimezone);
      const agentLocalTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), agentTimezone);
      let message = `I'm sorry, but ${customerLocalTime} (${agentLocalTime} agent time) is not available.`;

      if (alternatives.length > 0) {
        message += ` How about one of these: ${alternatives.map(alt => alt.customerTime).join(', ')}?`;
      } else {
        message += ` Could you suggest a different time?`;
      }

      return { success: false, message, alternatives, conflictReason: availabilityCheck.error || 'Time slot occupied' };
    }

    console.log(`✅ Time slot available for ${meetingDateUTC.toISO()} (UTC)`);

    // Save meeting data
    settings.meetingData = {
      email,
      datetime: formattedDatetime,
      location,
      purpose,
      customerTimezone: detectedCustomerTimezone,
      agentTimezone,
      agentId: settings.agentId,
      agentName: settings.agentName,
      agentEmail: settings.agentEmail,
      confirmationAttempts: (settings.meetingData?.confirmationAttempts || 0) + 1
    };

    // Schedule meeting
    const scheduleResult = await scheduleCalendarMeetingWithTimezone({
      email,
      datetime: formattedDatetime,
      location,
      purpose,
      customerTimezone: detectedCustomerTimezone,
      agentTimezone,
      agentId: settings.agentId,
      agentName: settings.agentName,
      agentEmail: settings.agentEmail,
      callSid,
      calendarConfig: settings.calendarConfig
    });

    if (scheduleResult.success) {
      await saveExtractedDetailsWithTimezone(callSid, {
        email,
        appointmentTime: formattedDatetime,
        location,
        purpose,
        hasConfirmation: true,
        customerTimezone: detectedCustomerTimezone,
        agentTimezone,
        agentId: settings.agentId,
        meetingId: scheduleResult.meetingId
      }, settings.calendarConfig);

      const customerTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), detectedCustomerTimezone);
      const agentTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), agentTimezone);

      let confirmationMessage = `Perfect! I've scheduled your ${purpose} for ${customerTime}`;
      if (detectedCustomerTimezone !== agentTimezone) {
        confirmationMessage += ` (${agentTime} my time)`;
      }
      confirmationMessage += `You'll will receive a confirmation email at ${email}.`;

      return { success: true, message: confirmationMessage, meetingId: scheduleResult.meetingId };
    } else {
      return { success: false, message: scheduleResult.error || "I'm having trouble scheduling. Could you try a different time?" };
    }

  } catch (error) {
    console.error("Error scheduling meeting:", error);
    return { success: false, message: "I encountered an error while scheduling. Could you please try again?" };
  }
}

// const callSettings = new Map();
async function handleHangUp(reason, callSid) {
  try {
    const settings = callSettings.get(callSid);

    // Clean up call settings
    callSettings.delete(callSid);
    sessions.delete(callSid);

    console.log(`📞 Call ${callSid} ended. Reason: ${reason || 'user ended call'}`);
    return {
      success: true,
      message: "Thank you for your time. Have a great day!",
      action: "call_ended",
      reason: reason || 'user ended call'
    };
  } catch (error) {
    console.error("Error ending call:", error);
    return { error: "Failed to end call" };
  }
}

// =============================================================================
// SYSTEM PROMPT AND FUNCTION CONFIGURATION
// =============================================================================

// function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
//   const currentTime = new Date().toISOString();
//   const agentTimezone = calendarConfig?.effective_timezone || 'UTC';

//   // Get current time in agent's timezone for context
//   const agentLocalTime = new Date().toLocaleString('en-US', {
//     timeZone: agentTimezone,
//     weekday: 'long',
//     year: 'numeric',
//     month: 'long',
//     day: 'numeric',
//     hour: '2-digit',
//     minute: '2-digit',
//     timeZoneName: 'short'
//   });

//   let enhancedPrompt = `${baseSystemPrompt}

// ALWAYS Use the function \`question_and_answer\` to respond to customer queries and questions.`;

//   if (calendarConfig && calendarConfig.calendar_access_token) {
//     enhancedPrompt += `

// ### Scheduling a meeting
// When a customer needs to schedule a meeting call:
// 1. Ask for their email
// 2. Ask for the purpose of their meeting (not needed for outbound call, just put discovery call as the purpose)
// 3. Request their preferred date and time for the meeting
// 4. Ask for their preferred location (London, Manchester or Brighton)
// 5. **IMPORTANT**: When customer mentions a time, clarify the timezone. For example: "Just to confirm, when you say 2 PM, do you mean 2 PM in London time?"
// 6. Use the \`schedule_meeting\` function tool to schedule the meeting– the tool will automatically handle timezone conversion and check availability
// 7. If the requested time is not available, suggest alternatives in the customer's preferred timezone
// 8. Once confirmed, use the \`schedule_meeting\` function again if needed
// 9. When the call naturally wraps up, use the \`hangUp\` tool to end the call.

// ### Timezone Information:
// - Your timezone (agent): ${agentTimezone}
// - Current time in your timezone: ${agentLocalTime}
// - Always confirm timezone with customer when they mention times
// - Meeting locations have default timezones: London/Manchester/Brighton = Europe/London timezone
// - Convert all times appropriately when confirming with customer`;
//   } else {
//     enhancedPrompt += `

// ### Note:
// - Meeting scheduling is currently unavailable. Focus on answering questions and gathering information.
// - If customer wants to schedule a meeting, let them know someone will follow up with them.`;
//   }

//   enhancedPrompt += `

// ### Additional Note:
// - Current UTC time: ${currentTime}
// - For scheduleMeeting tool, always use UTC format: YYYY-MM-DD HH:mm:ss
// - Use the \`hangUp\` tool to end the call.
// - Never mention any tool names or function names in your responses.
// - Always confirm timezone when discussing meeting times.`;

//   return enhancedPrompt;
// }

// function createAvailableFunctions(calendarConfig) {
//   const baseFunctions = [
//     {
//       name: "question_and_answer",
//       description: "Answer customer questions using knowledge base",
//       parameters: {
//         type: "object",
//         properties: {
//           query: { type: "string", description: "Customer's question" }
//         },
//         required: ["query"]
//       }
//     },
//     {
//       name: "hangUp",
//       description: "End the call gracefully",
//       parameters: {
//         type: "object",
//         properties: {
//           reason: { type: "string", description: "Reason for ending the call" }
//         }
//       }
//     }
//   ];

//   // Only add meeting scheduling function if calendar is configured
//   if (calendarConfig && calendarConfig.calendar_access_token) {
//     baseFunctions.push({
//       name: "schedule_meeting",
//       description: "Schedule a meeting with the customer",
//       parameters: {
//         type: "object",
//         properties: {
//           email: { type: "string", description: "Customer's email address" },
//           datetime: { type: "string", description: "Meeting date and time in UTC format YYYY-MM-DD HH:mm:ss" },
//           location: { type: "string", enum: ["London", "Manchester", "Brighton"], description: "Meeting location" },
//           purpose: { type: "string", default: "discovery call", description: "Purpose of the meeting" },
//           timezone: { type: "string", description: "Customer's timezone (optional, will be detected from location)" }
//         },
//         required: ["email", "datetime", "location"]
//       }
//     });
//   }

//   return baseFunctions;
// }

// =============================================================================
// ENHANCED AI RESPONSE WITH FUNCTION CALLING
// =============================================================================

  async function aiResponseWithFunctions(messages, model, temperature, maxTokens, availableFunctions) {
    const completion = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
      functions: availableFunctions,
      function_call: "auto"
    });

    return completion.choices[0].message;
  }
  // end



  /* -------------------------------------------------------------------------- */
  /* Helper: Save and Fetch Call Settings                                       */
  /* -------------------------------------------------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


  // const streamToCallMap = new Map(); // 🔧 NEW: streamSid → callSid

  async function saveCallSettings(callSid, data) {
    data.createdAt = Date.now();
    callSettings.set(callSid, data);
    console.log(`💾 SAVED ${callSid}: agentId=${data.agentId}, KB=${data.knowledgeChunks?.length || 0}`);
  }

  async function getCallSettings(streamSid) {
    // 🔧 LOOKUP by streamSid → callSid → settings
    const callSid = streamToCallMap.get(streamSid);
    if (!callSid) {
      console.log(`❌ NO CALLSID for streamSid ${streamSid}`);
      console.log(`Active streamSids (${streamToCallMap.size}):`, Array.from(streamToCallMap.keys()));
      return null;
    }
    
    const settings = callSettings.get(callSid);
    if (settings) {
      console.log(`✅ LOADED via ${streamSid}→${callSid}: KB=${settings.knowledgeChunks?.length || 0}`);
    }
    return settings || null;
  }

  /* -------------------------------------------------------------------------- */
  /* ✅ /twiml — Twilio Webhook                                                 */
  /* -------------------------------------------------------------------------- */
  fastify.all("/twiml", async (request, reply) => {
    try {
      const callSid = request.body.CallSid || request.query.CallSid;

      const vr = new Twilio.twiml.VoiceResponse();

      vr.say("Hello! Connecting you to the AI assistant.");

      const connect = vr.connect();
      connect.stream({
        url: `wss://${DOMAIN}/ws-direct`, // our new WS handler
      });

      reply.type("text/xml").send(vr.toString());
    } catch (error) {
      console.error("❌ Error generating TwiML (stream):", error);
      reply
        .type("text/xml")
        .send(
          `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say voice="alice">Internal Error: ${error.message}</Say>
          </Response>`
        );
    }
  });

  
  
  fastify.post("/call-me", async (request, reply) => {
  const {
    number: toNumber,
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
    transcriberProvider,
    transcriberLanguage,
    transcriberModel,
    aiModel,
    temperature,
    systemPrompt,
    firstMessage,
    maxTokens,
    agentId,
    // Optional Sarvam fields (you can add them to your frontend later)
    sarvamVoice = "arya",
    sarvamLanguage = "hi",
  } = request.body;

  if (!toNumber || !/^\+\d+$/.test(toNumber)) {
    return reply.code(400).send({ error: "Invalid or missing 'number'" });
  }

  try {
    const client = Twilio(twilioAccountSid, twilioAuthToken);

    const [calendarConfig, knowledgeChunks] = await Promise.all([
      getAgentCalendarConfig(agentId),
      preFetchAgentKnowledge(agentId),
    ]);

    const enhancedSystemPrompt = createEnhancedSystemPrompt(systemPrompt, calendarConfig);

    const call = await client.calls.create({
      to: toNumber,
      from: twilioPhoneNumber,
      url: `https://${DOMAIN}/twiml`,
      record: true,
      recordingChannels: "dual",
    });

    console.log(`📞 Twilio call created: ${toNumber} | SID: ${call.sid}`);

  const settingsData = {
  agentId,
  transcriberProvider,
  transcriberLanguage,
  transcriberModel,
  aiModel,
  temperature: parseFloat(temperature),
  systemPrompt: enhancedSystemPrompt, // This already has the full prompt
  agentPrompt: systemPrompt, // ✅ Store the original prompt too
  firstMessage,
  maxTokens: parseInt(maxTokens, 10),
  calendarConfig: calendarConfig || null,
  knowledgeChunks,
  sarvamVoice,
  sarvamLanguage,
};
    await saveCallSettings(call.sid, settingsData);
    console.log(`✅ callSettings saved for CallSid ${call.sid}`);

    let savedSettings = null;
    for (let i = 0; i < 5; i++) {
      savedSettings = await getCallSettings(call.sid);
      if (savedSettings) break;
      await new Promise(r => setTimeout(r, 200));
    }

    reply.send({
      success: true,
      callSid: call.sid,
      to: toNumber,
      settingsReady: !!savedSettings,
    });
  } catch (err) {
    console.error("❌ Failed to create outbound call:", err);
    reply.code(500).send({ error: "Failed to create call", details: err.message });
  }
});
  
    // Add this near the top of the /ws-direct handler
let audioBuffer = Buffer.alloc(0);
const MIN_CHUNK_TO_SEND = 8000 * 2 * 0.25; // 250 ms of 8kHz 16-bit mono = 4000 bytes
  fastify.register(async function (f) {
  f.get("/ws-direct", { websocket: true }, (twilioWs, req) => {
    console.log("\nTwilio WebSocket connected (/ws-direct)");

    let audioBuffer = Buffer.alloc(0);
    const MIN_CHUNK_TO_SEND = 8000 * 2 * 0.25; // 250 ms of audio (4000 bytes)

    const state = {
      streamSid: null,
      botSpeaking: false,
      userSpeaking: false,
      interrupted: false,
      lastUserActivity: Date.now(),
      sessionStartTime: Date.now(),
      currentTranscript: "",
      fullTranscript: [],
      audioQueue: [],
      metrics: { interruptsCount: 0, messagesCount: 0 },

      // Helper method to send audio to Twilio (used by speakText)
      sendAudio: async function (buffer) {
        if (!this.streamSid || !twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
          console.log("[state.sendAudio] Connection not ready — skipping");
          return;
        }
        await sendAudioToTwilio(buffer, this, twilioWs, 160);
      },

      // Helper to stop current bot speech (used for interruption)
      stopAudio: function () {
        this.interrupted = true;
        this.botSpeaking = false;
        if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
          sendClearEvent(twilioWs, this.streamSid);
        }
      }
    };

    // Connect Sarvam STT when stream starts
    // const connectSarvam = async () => {
    //   if (!state.streamSid) {
    //     console.error("Cannot connect Sarvam: streamSid missing");
    //     return;
    //   }

    //   const settings = await getCallSettings(state.streamSid);
    //   if (!settings) {
    //     console.error("No settings found for Sarvam");
    //     return;
    //   }

    //   const languageMap = {
    //     'en': 'en-IN',
    //     'hi': 'hi-IN',
    //     'kn': 'kn-IN',
    //     'ta': 'ta-IN',
    //     'te': 'te-IN',
    //     'mr': 'mr-IN',
    //   };

    //   const lang = languageMap[settings.transcriberLanguage?.split('-')[0]] || 'kn-IN';

    //   // Clean up old connection if exists
    //   if (state.stt) {
    //     state.stt.close();
    //   }

    //   state.stt = new SarvamSTT();

    //   try {
    //     console.log(`🚀 [Main] Connecting Sarvam STT (lang: ${lang})...`);
    //     await state.stt.connect(lang);
    //     console.log(`✅ [Main] Sarvam STT ready for audio`);
    //   } catch (error) {
    //     console.error(`❌ [Main] Failed to connect Sarvam STT:`, error);
    //     return;
    //   }

    //   // Set up STT callbacks
    //   state.stt.onTranscript = (text, isFinal) => {
    //     if (!text?.trim()) return;

    //     const transcript = text.trim();

    //     // Handle interim transcripts (optional)
    //     if (!isFinal) {
    //       state.currentTranscript = transcript;
    //       return;
    //     }

    //     // Filter out very short / filler-only final transcripts
    //     const words = transcript.split(/\s+/).filter(Boolean);
    //     const isVeryShort = transcript.length < 6 || words.length <= 1;
    //     const isFillerOnly =
    //       ['ok', 'okay', 'yeah', 'yes', 'no', 'uh', 'um', 'hmm', 'right', 'sure', 'got it', 'mhm'].includes(
    //         transcript.toLowerCase()
    //       ) ||
    //       transcript.match(/^(uh+|um+|mm+|yeah+|ok+|mhm+)\s*$/i);

    //     if (isVeryShort || isFillerOnly) {
    //       console.log(`[TURN-SKIP] Ignored short/filler: "${transcript}" (${words.length} words)`);
    //       if (!state.botSpeaking && Date.now() - (state.lastBotSpeechEnd || 0) > 12000) {
    //         speakText("Got it...", state, twilioWs, { pace: 1.1 });
    //       }
    //       return;
    //     }

    //     // Wait for silence before accepting turn
    //     state.pendingUserText = transcript;
    //     state.lastSpeechEndTime = Date.now();

    //     if (state.turnDecisionTimeout) {
    //       clearTimeout(state.turnDecisionTimeout);
    //     }

    //     state.turnDecisionTimeout = setTimeout(() => {
    //       const now = Date.now();
    //       const silenceMs = now - state.lastSpeechEndTime;

    //       if (silenceMs >= 1000 && state.pendingUserText) {
    //         console.log(`[TURN-ACCEPT] "${state.pendingUserText}" after ${silenceMs}ms silence`);
    //         processTurn(state.pendingUserText, state, twilioWs);
    //         state.pendingUserText = null;
    //       }
    //     }, 1100);
    //   };

    //   state.stt.onError = (err) => {
    //     console.error("❌ [Main] Sarvam STT error:", err);
    //   };
    // };

   const connectDeepgram = async () => {
  const settings = await getCallSettings(state.streamSid);
  if (!settings) return;

  if (state.stt) state.stt.close();

  state.stt = new DeepgramSTT({
    language: settings.transcriberLanguage,
    model: settings.transcriberModel,
  });

  // ✅ NEW: Handle interruptions
  state.stt.onInterruption = (text) => {
    // Only trigger if bot is currently speaking
    if (state.botSpeaking) {
      console.log(`🛑 INTERRUPTION DETECTED: "${text}"`);
      
      // Immediately stop bot speech
      state.interrupted = true;
      state.botSpeaking = false;
      
      // Clear Twilio's audio buffer
      sendClearEvent(twilioWs, state.streamSid);
      
      // Update metrics
      state.metrics.interruptsCount++;
    }
  };

  // Handle final transcripts
  state.stt.onTranscript = (text) => {
    state.lastUserActivity = Date.now();
    
    // Only process if not currently being interrupted
    if (!state.interrupted) {
      processTurn(text, state, twilioWs);
    } else {
      // Reset interrupted flag and process the interrupting text
      console.log(`📝 Processing interruption text: "${text}"`);
      state.interrupted = false;
      processTurn(text, state, twilioWs);
    }
  };

  await state.stt.connect();
};


    // Main Twilio WebSocket message handler
    twilioWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        // if (evt.event === "start") {
        //   state.streamSid = evt.start.streamSid;
        //   const twilioCallSid = evt.start.callSid;

        //   if (twilioCallSid) {
        //     streamToCallMap.set(state.streamSid, twilioCallSid);
        //     console.log(`MAPPED ${state.streamSid} → ${twilioCallSid}`);
        //   }

        //   console.log(`Stream started: ${state.streamSid}`);

        //   // await connectSarvam();
        //  await connectDeepgram();
        //   // Send welcome message
        //   setTimeout(async () => {
        //     const settings = await getCallSettings(state.streamSid);
        //     if (!settings) {
        //       console.error("Settings missing for first message!");
        //       await speakText("Hello! How can I help you today?", state, twilioWs);
        //       return;
        //     }

        //     const firstMsg = settings.firstMessage || "Hello! How can I help you today?";
        //     console.log(`AI FIRST MESSAGE: "${firstMsg}"`);

        //     await speakText(firstMsg, state, twilioWs, {
        //       voice: settings.sarvamVoice || "arya",
        //       languageCode: settings.sarvamLanguage || "hi-IN",
        //       pace: 1.0
        //     });
        //   }, 800);

        //   return;
        // }



// =============================================================================
// FIX 3: Alternative approach using Twilio API (if above doesn't work)
// =============================================================================

// If the above still doesn't work, use this fallback that queries Twilio API:

// In the WebSocket start event handler:
if (evt.event === "start") {
  state.streamSid = evt.start.streamSid;
  const callSid = evt.start.callSid;

  if (callSid) {
    streamToCallMap.set(state.streamSid, callSid);
    console.log(`MAPPED ${state.streamSid} → ${callSid}`);
  }

  console.log(`Stream started: ${state.streamSid}`);

  await connectDeepgram();
  
  // Send welcome message with retry logic
  setTimeout(async () => {
    let settings;
    for (let i = 0; i < 10; i++) {
      settings = await getCallSettings(state.streamSid);
      if (settings) {
        console.log(`✅ Settings loaded on attempt ${i + 1}:`, {
          firstMessage: settings.firstMessage,
          hasFirstMessage: !!settings.firstMessage,
          agentName: settings.agentName
        });
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!settings) {
      console.error("Settings missing for first message!");
      await speakText("Hello! How can I help you today?", state, twilioWs);
      return;
    }

    // ✅ Use the firstMessage from settings (from database)
    const firstMsg = settings.firstMessage || "Hello! How can I help you today?";
    console.log(`🎯 AI FIRST MESSAGE from DB: "${firstMsg}"`);

    await speakText(firstMsg, state, twilioWs, {
      voice: settings.sarvamVoice || "arya",
      languageCode: settings.sarvamLanguage,
      pace: 1.0
    });
  }, 800);
}

        // if (evt.event === "media") {
        //   const mulawChunk = Buffer.from(evt.media.payload, "base64");

        //   // Convert μ-law to linear PCM for Sarvam STT
        //   const linear8k = new Int16Array(mulawChunk.length);
        //   for (let i = 0; i < mulawChunk.length; i++) {
        //     const mu = ~mulawChunk[i] & 0xff;
        //     let t = ((mu & 0x0f) << 3) + 33;
        //     t = (t << ((mu & 0x70) >> 4)) - 33;
        //     linear8k[i] = (mu & 0x80) ? -t : t;
        //   }

        //   audioBuffer = Buffer.concat([audioBuffer, Buffer.from(linear8k.buffer)]);

        //   // Send chunks to STT when we have enough audio
        //   while (audioBuffer.length >= MIN_CHUNK_TO_SEND) {
        //     const toSend = audioBuffer.slice(0, MIN_CHUNK_TO_SEND);
        //     audioBuffer = audioBuffer.slice(MIN_CHUNK_TO_SEND);

        //     if (state.stt && typeof state.stt.sendAudio === 'function') {
        //       state.stt.sendAudio(toSend);
        //       console.log(`[AUDIO] Sent ${toSend.length} bytes to STT`);
        //     } else {
        //       console.warn("[AUDIO] STT not ready — dropping chunk");
        //     }
        //   }

        //   // Interruption detection: check volume if bot is speaking
        //   if (state.botSpeaking) {
        //     const volume = calculateVolume(mulawChunk);
        //     if (volume > 500) { // Adjust threshold based on testing
        //       console.log(`[INTERRUPT] User interruption detected (volume: ${volume})`);
        //       state.stopAudio();
        //       state.metrics.interruptsCount++;
        //     }
        //   }
        // }

        
if (evt.event === "media") {
  if (!state.stt || !state.stt.ready) return;
  const mulawChunk = Buffer.from(evt.media.payload, "base64");
  state.stt.sendAudio(mulawChunk);
}



        if (evt.event === "stop") {
          console.log("Call ended by Twilio");
          cleanup();
        }
      } catch (e) {
        console.error("WS message error:", e);
      }
    });

    twilioWs.on("close", () => {
      console.log("📞 Twilio WebSocket closed");
      cleanup();
    });

    // Idle timeout
    const idleCheck = setInterval(() => {
      const now = Date.now();
      const idleMs = now - state.lastUserActivity;

      if (state.botSpeaking || state.audioQueue.length > 0) {
        state.lastUserActivity = now;
        return;
      }

      if (idleMs > 60000) {
        console.log(`⏱️ Call silent for ${idleMs/1000|0}s → ending politely`);
        state.botSpeaking = true;
        speakText(
          "Thanks for calling! If you have any more questions feel free to call back. Goodbye.",
          state,
          twilioWs
        ).then(() => {
          setTimeout(() => twilioWs.close(), 2500);
        });
        clearInterval(idleCheck);
      }
    }, 5000);

    const cleanup = () => {
      clearInterval(idleCheck);
      if (state.stt) {
        state.stt.close();
         state.stt = null;
      }
      // Optional: clear other resources
    };
  });
});



// Volume detection helper for interruption
function calculateVolume(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const sample = buffer[i] - 128; // μ-law to signed
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

async function processTurn(userText, state, twilioWs) {
  if (!userText?.trim()) return;

  const streamSid = state.streamSid;
  const callSid = streamToCallMap.get(streamSid);
  const settings = await getCallSettings(streamSid);
  
  if (!settings) {
    console.warn(`[processTurn] No settings found for ${streamSid}`);
    return;
  }

  if (state.botSpeaking) {
    console.log("[processTurn] Bot speaking - waiting for interruption to complete");
    await new Promise(r => setTimeout(r, 200));
  }

  const cleaned = userText.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (cleaned.length < 6 || words.length < 2) {
    console.log(`[SKIP short] "${cleaned}"`);
    return;
  }

  console.log(`[USER FINAL] "${cleaned}" (${words.length} words)`);

  const conversation = sessions.get(callSid) || [];

  // ✅ ENHANCED: Get relevant knowledge based on actual user query
  let relevantChunks = [];
  if (settings.knowledgeChunks && settings.knowledgeChunks.length > 0) {
    relevantChunks = await getRelevantChunks(
      cleaned,
      settings.agentId,
      settings.knowledgeChunks,
      5 // Get top 5 most relevant chunks
    );
  }

  let kbContext = "";
  if (relevantChunks.length > 0) {
    kbContext = relevantChunks
      .map(chunk => chunk.content)
      .join('\n\n');
    
    console.log(`📚 Knowledge context: ${kbContext.length} chars from ${relevantChunks.length} chunks`);
  }

  let agentPrompt = settings.agentPrompt || settings.systemPrompt || "";

  const systemPrompt = `
${agentPrompt}

${kbContext ? `\nADDITIONAL KNOWLEDGE:\n${kbContext}` : ''}

CONVERSATION GUIDELINES:
1. Keep responses conversational and natural
2. Use the knowledge provided above to answer questions accurately
3. If you don't know something even after checking the knowledge, say so and offer to connect with a specialist
4. Be helpful and professional
5. Don't make up information
6. Keep responses concise - aim for 2-3 sentences maximum
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversation.slice(-8),
    { role: "user", content: cleaned }
  ];

  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
    console.warn("[processTurn] Twilio WS not open — skipping response");
    state.botSpeaking = false;
    return;
  }

  // Generate AI response
  let botReply;
  try {
    botReply = await aiResponse(
      null,
      messages,
      settings.aiModel || "gpt-4o-mini",
      settings.temperature ?? 0.7,
      settings.maxTokens ?? 180
    );

    botReply = (botReply || "").trim();
    
    if (!botReply || botReply.length < 10) {
      botReply = "I'm not sure about that. Could you tell me more?";
    }

  } catch (err) {
    console.error("[LLM error]", err);
    botReply = "Sorry, something went wrong. One moment please.";
  }

  if (state.interrupted) {
    console.log("[processTurn] Interrupted during AI response - skipping speech");
    state.interrupted = false;
    return;
  }

  // Speak the response
  state.lastUserActivity = Date.now();

  await speakText(botReply, state, twilioWs, {
    voice: settings.sarvamVoice || "arya",
    languageCode: settings.sarvamLanguage,
    pace: 1.05,
  });

  // Update history only if not interrupted
  if (!state.interrupted) {
    conversation.push(
      { role: "user", content: cleaned, ts: Date.now() },
      { role: "assistant", content: botReply, ts: Date.now() }
    );

    if (conversation.length > 20) {
      conversation.splice(0, conversation.length - 16);
    }

    sessions.set(callSid, conversation);
  }
  
  state.lastBotSpeechEnd = Date.now();
}


// In SarvamTTS class — keep generateSpeech as-is, but use this new speakText
async function speakText(text, state, twilioWs, ttsOptions = {}) {
  if (state.callEnded || !twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
    state.botSpeaking = false;
    return;
  }

  if (!text?.trim()) {
    state.botSpeaking = false;
    return;
  }

  // ✅ Reset interrupted flag at start
  state.interrupted = false;
  state.botSpeaking = true;

  try {
    console.log(`[SPEAK START] "${text.slice(0,80)}..."`);

    // ✅ Send clear event before starting new speech
    sendClearEvent(twilioWs, state.streamSid);
    
    // Small delay to ensure clear event is processed
    await new Promise(r => setTimeout(r, 100));

    const totalBytes = await ttsManager.generateAndStream(
      text,
      {
        voice: ttsOptions.voice || "arya",
        languageCode: "ka-IN",
        pitch: 0.0,
        pace: ttsOptions.pace ?? 1.05,
      },
      twilioWs,
      state
    );

    if (state.interrupted) {
      console.log(`[SPEAK] Interrupted after ${totalBytes} bytes`);
      sendClearEvent(twilioWs, state.streamSid);
    } else {
      console.log(`[SPEAK] Completed ${totalBytes} bytes`);
    }
  } catch (err) {
    console.error("[SPEAK ERROR]", err.message || err);
  } finally {
    state.botSpeaking = false;
    state.lastBotSpeechEnd = Date.now();
  }
}



// Add this function to handle user interruptions
function setupInterruptionDetection(state, twilioWs) {
  // This is where you'd integrate with your speech recognition system
  // For example, with a WebSocket that receives transcriptions:
  
  speechWs.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    
    if (data.transcript) {
      const transcript = data.transcript.toLowerCase();
      
      // Check for interruption keywords
      if (transcript.includes("stop") || 
          transcript.includes("wait") || 
          transcript.includes("hold on")) {
        
        console.log("🛑 User interruption detected: " + transcript);
        
        // Set the interrupted flag
        state.interrupted = true;
        
        // If bot is speaking, stop it immediately
        if (state.botSpeaking) {
          // Send clear event to Twilio
          sendClearEvent(twilioWs, state.streamSid);
          
          // Clear the audio queue
          state.audioQueue = [];
          
          // Set botSpeaking to false
          state.botSpeaking = false;
        }
      }
    }
  });
}


// Add this function to send mark events to Twilio
function sendMarkEvent(twilioWs, streamSid, markName) {
  if (twilioWs && twilioWs.readyState === 1 && streamSid) {
    twilioWs.send(
      JSON.stringify({
        event: "mark",
        streamSid: streamSid,
        mark: { name: markName }
      })
    );
    console.log(`Sent mark event: ${markName}`);
  }
}

function pcm16ToMuLaw(pcmBuffer) {
  const mulaw = Buffer.alloc(pcmBuffer.length / 2);

  for (let i = 0; i < mulaw.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);

    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > 32635) sample = 32635;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa);
  }

  return mulaw;
}


function downsample16kTo8k(pcm16k) {
  const output = Buffer.alloc(pcm16k.length / 2);

  for (let i = 0, j = 0; i < pcm16k.length; i += 4, j += 2) {
    const sample = pcm16k.readInt16LE(i);
    output.writeInt16LE(sample, j);
  }

  return output;
}


async function sendAudioToTwilio(pcmAudio, state, ws) {
  if (!state.streamSid || ws.readyState !== WebSocket.OPEN) return;

  // 1️⃣ Convert 16kHz → 8kHz
  const pcm8k = downsample16kTo8k(pcmAudio);

  // 2️⃣ Convert PCM → μ-law
  const mulaw = pcm16ToMuLaw(pcm8k);

  // 3️⃣ Send to Twilio
  ws.send(JSON.stringify({
    event: "media",
    streamSid: state.streamSid,
    media: {
      payload: mulaw.toString("base64"),
    },
  }));
}

fastify.post("/end-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  const settings = callSettings.get(callSid);
  if (!settings) {
    return reply.code(404).send({ error: "Call not found" });
  }
  try {
    const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
    await client.calls(callSid).update({ status: 'completed' });
    console.log(`📞 Call ${callSid} ended via API`);
    callSettings.delete(callSid);
    sessions.delete(callSid);
    reply.send({ success: true, message: "Call ended successfully" });
  } catch (err) {
    console.error("❌ Failed to end call:", err);
    reply.code(500).send({ error: "Failed to end call", details: err.message });
  }
});

fastify.post("/preview-agent", async (request, reply) => {
  const {
    agentId,
    userInput,
    aiModel,
    temperature,
    maxTokens,
    systemPrompt,
    firstMessage,
  } = request.body;

  try {
    // Get the agent's workflow and knowledge base from Pinecone
    const [workflow, knowledgeChunks] = await Promise.all([
      getActiveWorkflowForAgent(agentId),
      preFetchAgentKnowledge(agentId)
    ]);

    const startNode = workflow?.nodes?.find(n => !workflow.edges.some(e => e.to_node_id === n.id));
    let currentNodeId = startNode?.id;
    let extractedVariables = {};

    // Build the dynamic prompt with knowledge base and current step
    let dynamicPrompt = systemPrompt || "";
    if (startNode) {
      const nodeConfig = typeof startNode.config === 'string'
        ? JSON.parse(startNode.config)
        : startNode.config;
      dynamicPrompt += `\n\nCurrent Step: ${startNode.name}`;
      if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
    }

    // Combine all knowledge chunks, not just the first
    const knowledgeContext = knowledgeChunks.map(chunk => chunk.content).join("\n\n");
    dynamicPrompt += '\n\nKnowledge Base:\n' + knowledgeContext;

    // Build conversation messages
    const messages = [
      { role: "system", content: dynamicPrompt },
      { role: "assistant", content: firstMessage || "How can I help you today?" },
      { role: "user", content: userInput }
    ];

    // Get AI response from OpenAI
    const completion = await openai.chat.completions.create({
      model: aiModel || "gpt-4",
      temperature: temperature !== undefined ? parseFloat(temperature) : 0.7,
      max_tokens: maxTokens !== undefined ? parseInt(maxTokens, 10) : 256,
      messages
    });

    const aiReply = completion.choices[0].message.content;

    // Extract variables if configured in the first node
    if (startNode?.config?.variableExtractionPlan) {
      const newVariables = await extractVariables(
        userInput,
        startNode.config.variableExtractionPlan
      );
      extractedVariables = { ...extractedVariables, ...newVariables };
    }

    // Determine next node for multi-turn preview
    let nextNodeId = null;
    if (workflow && currentNodeId) {
      nextNodeId = determineNextNode(workflow, currentNodeId, aiReply, userInput);
    }

    // Return AI reply and extracted variables
    reply.send({
      success: true,
      aiReply,
      extractedVariables,
      nextNodeId
    });
  } catch (err) {
    console.error("❌ Failed to preview agent:", err);
    reply.code(500).send({ error: "Failed to preview agent", details: err.message });
  }
});

// fastify.register(workflowRoutes, { prefix: '/api' });

fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    const callSid = req.query.callSid;
    const settings = callSettings.get(callSid);
    if (!settings) {
      console.error("❌ Unknown callSid in WebSocket:", callSid);
      ws.close();
      return;
    }
    ws.on("message", async (data) => {
      const message = JSON.parse(data);
      switch (message.type) {
        case "setup":
          console.log("⚙️ Setup received for CallSid:", callSid);
          ws.callSid = callSid;
          sessions.set(callSid, []);
          break;
        case 'prompt':
          console.log('🎤 Prompt:', message.voicePrompt);
          const conversation = sessions.get(callSid) || [];
          conversation.push({ role: 'user', content: message.voicePrompt });
          const { workflow, currentNodeId, knowledgeChunks } = settings;
          const currentNode = workflow?.nodes?.find(n => n.id === currentNodeId);
          if (currentNode?.type === 'end_call') {
            console.log('🛑 End call node reached');
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
            if (nodeConfig.actions) {
              await executeNodeActions(nodeConfig.actions, settings.extractedVariables, callSid);
            }
            const endMessage = nodeConfig.prompt || 'Thank you for your time. Goodbye!';
            try {
              const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
              await client.calls(callSid).update({ status: 'completed' });
              console.log(`📞 Call ${callSid} ended via Twilio API`);
            } catch (err) {
              console.error("❌ Failed to end call via Twilio API:", err);
            }
            setTimeout(() => {
              ws.close();
              callSettings.delete(callSid);
              sessions.delete(callSid);
            }, 3000);
            return;
          }
          const topChunk = settings.knowledgeChunks?.[0]?.content || '';
          console.log('📌 Pre-fetched knowledge chunks used');
          let dynamicPrompt = settings.systemPrompt;
          if (currentNode) {
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
            dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
            if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
            if (Object.keys(settings.extractedVariables).length > 0) {
              dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(settings.extractedVariables)}`;
            }
          }
          dynamicPrompt += '\n\nContext:\n' + topChunk;
          const messages = [
            { role: "system", content: dynamicPrompt },
            ...conversation,
          ];
          // 🔧 FIX: Use function calling if calendar is configured
          let response = '';
          if (settings.calendarConfig && settings.availableFunctions) {
            console.log('📞 Using function calling for meeting scheduling');
            const aiMessage = await aiResponseWithFunctions(
              messages,
              settings.aiModel,
              settings.temperature,
              settings.maxTokens,
              settings.availableFunctions
            );

            // Check if AI wants to call a function
            if (aiMessage.function_call) {
              console.log('🔧 Function call detected:', aiMessage.function_call.name);

              try {
                const functionName = aiMessage.function_call.name;
                const functionArgs = JSON.parse(aiMessage.function_call.arguments);

                let functionResult;
                switch (functionName) {
                  case 'schedule_meeting':
                    console.log('📅 Scheduling meeting with args:', functionArgs);
                    functionResult = await handleScheduleMeeting(functionArgs, callSid, settings);
                    break;

                  case 'question_and_answer':
                    console.log('❓ Answering question:', functionArgs.query);
                    functionResult = await handleQuestionAnswer(functionArgs.query, settings);
                    break;

                  case 'hangUp':
                    console.log('📞 Hanging up call:', functionArgs.reason);
                    functionResult = await handleHangUp(functionArgs.reason, callSid);
                    break;

                  default:
                    console.warn('⚠️ Unknown function:', functionName);
                    functionResult = { error: `Unknown function: ${functionName}` };
                }

                // Send function result back to customer
                response = functionResult.message || functionResult.answer || 'Function executed successfully.';
                ws.send(JSON.stringify({ type: "text", token: response, last: true }));

                // If it was a hangup, close the connection
                if (functionName === 'hangUp') {
                  ws.close();
                  return;
                }

              } catch (error) {
                console.error('❌ Error executing function:', error);
                response = "I apologize, but I encountered an error. Could you please try again?";
                ws.send(JSON.stringify({ type: "text", token: response, last: true }));
              }
            } else if (aiMessage.content) {
              // No function call, but we have content - stream it
              response = aiMessage.content;
              ws.send(JSON.stringify({ type: "text", token: response, last: true }));
            } else {
              // Fallback to regular streaming response
              response = await aiResponse(
                ws,
                messages,
                settings.aiModel,
                settings.temperature,
                settings.maxTokens
              );
            }
          } else {
            // Fallback to regular streaming response if no calendar configured
            console.log('📞 Using regular response (no calendar configured)');
            response = await aiResponse(
              ws,
              messages,
              settings.aiModel,
              settings.temperature,
              settings.maxTokens
            );
          }

          console.log("🤖 AI processing completed:", response);
          if (currentNode?.config?.variableExtractionPlan) {
            const newVariables = await extractVariables(
              message.voicePrompt,
              currentNode.config.variableExtractionPlan
            );
            settings.extractedVariables = {
              ...settings.extractedVariables,
              ...newVariables
            };
            console.log('📝 Extracted variables:', newVariables);
          }
          if (workflow && currentNodeId) {
            const nextNodeId = determineNextNode(workflow, currentNodeId, response, message.voicePrompt);
            if (nextNodeId) {
              settings.currentNodeId = nextNodeId;
              console.log('⏭️ Moving to next node:', nextNodeId);
            }
          }
          conversation.push({ role: "assistant", content: response });
          break;
        case "interrupt":
          console.log("🔕 Interrupt received.");
          break;
        default:
          console.warn("⚠️ Unknown message type:", message.type);
      }
    });
    ws.on("close", () => {
      console.log("🛑 WebSocket closed");
      sessions.delete(callSid);
      callSettings.delete(callSid);
    });
  });
});


function linearToMulawSample(sample) {
  const MU_LAW_MAX = 0x1FFF;
  const BIAS = 33;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa);
}

fastify.all("/inbound-call", async (req, reply) => {
  const incomingNumber = req.body.To; // Your Twilio number that received the call
  const fromNumber = req.body.From;   // Caller's number
  const callSid = req.body.CallSid;

  console.log("🔥 INBOUND CALL RECEIVED", { 
    to: incomingNumber, 
    from: fromNumber,
    callSid 
  });

  // ✅ NEW: Pre-load and save settings BEFORE WebSocket connects
  try {
    const inboundSettings = await loadInboundSettingsByPhone(incomingNumber);

    if (!inboundSettings) {
      console.error(`❌ No inbound config found for ${incomingNumber}`);
      const vr = new Twilio.twiml.VoiceResponse();
      vr.say("Sorry, this number is not configured yet. Please contact support.");
      return reply.type("text/xml").send(vr.toString());
    }

    // Save settings immediately using callSid
    await saveCallSettings(callSid, {
      ...inboundSettings,
      fromNumber,      // Store caller's number
      toNumber: incomingNumber,
      isInbound: true
    });
    
    sessions.set(callSid, []);

    console.log(`✅ Pre-loaded inbound settings for callSid ${callSid}`);

  } catch (error) {
    console.error("❌ Error pre-loading inbound settings:", error);
    const vr = new Twilio.twiml.VoiceResponse();
    vr.say("Sorry, there was a configuration error. Please try again later.");
    return reply.type("text/xml").send(vr.toString());
  }

  // Generate TwiML response
  const vr = new Twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  
  // We don't rely on custom parameters anymore - settings are already saved
  connect.stream({
    url: `wss://${DOMAIN}/ws-direct`
  });

  reply.type("text/xml").send(vr.toString());
});

async function loadInboundSettingsByPhone(phoneNumber) {
  try {
    console.log(`🔍 Looking up inbound config for ${phoneNumber}`);
    
    const configResult = await db.query(`
      SELECT * FROM inbound_configs 
      WHERE phone_number = $1
    `, [phoneNumber]);

    if (!configResult.rows.length) {
      console.log(`❌ No inbound config found for ${phoneNumber}`);
      return null;
    }

    const config = configResult.rows[0];
    const agentResult = await db.query(`
      SELECT * FROM agents 
      WHERE id::text = $1::text
    `, [config.agent_id]);

    if (!agentResult.rows.length) {
      console.error(`❌ Agent ${config.agent_id} not found`);
      return null;
    }

    const agent = agentResult.rows[0];
    console.log(`✅ Agent found: ${agent.name}`);

    // ✅ SAFE: Extract first_message correctly
    let firstMessage = "Hello! How can I help you today?";
    if (agent.conversation_config?.agent?.first_message) {
      firstMessage = agent.conversation_config.agent.first_message;
    } else if (config.greeting_message) {
      firstMessage = config.greeting_message;
    }

    // ✅ SAFE: Extract system prompt without modifying structure
    let systemPrompt = "You are a helpful AI assistant.";
    if (agent.conversation_config?.agent?.prompt) {
      const promptConfig = agent.conversation_config.agent.prompt;
      if (typeof promptConfig === 'object' && promptConfig.prompt) {
        systemPrompt = promptConfig.prompt;
      } else if (typeof promptConfig === 'string') {
        systemPrompt = promptConfig;
      }
    }

    // Load calendar and knowledge WITHOUT modifying knowledge chunks
    const [calendarConfig, knowledgeChunks] = await Promise.all([
      getAgentCalendarConfig(agent.id),
      preFetchAgentKnowledge(agent.id),
    ]);

    // ✅ IMPORTANT: Return the SAME structure as outbound calls
    return {
      agentId: agent.id,
      agentName: agent.name,
      // Use LLM from agent config or default
      aiModel: agent.conversation_config?.agent?.prompt?.llm || "gpt-4o-mini",
      temperature: Number(agent.conversation_config?.agent?.prompt?.temperature || 0.7),
      maxTokens: Number(agent.conversation_config?.agent?.prompt?.max_tokens || 180),
      // Use createEnhancedSystemPrompt which already handles calendar config
      systemPrompt: createEnhancedSystemPrompt(systemPrompt, calendarConfig),
      firstMessage: firstMessage,
      calendarConfig,
      knowledgeChunks, // Keep original knowledge chunks
      sarvamVoice: config.voice || "arya",
      sarvamLanguage: "hi",
      transcriberLanguage: "en",
      transcriberModel: "nova-2-general",
      isInbound: true,
      // ✅ Store the agent's original prompt separately if needed
      agentPrompt: systemPrompt
    };
  } catch (error) {
    console.error("❌ Error in loadInboundSettingsByPhone:", error);
    throw error;
  }
}
fastify.post("/debug/inbound-lookup", async (req, reply) => {
  const { phoneNumber } = req.body;

  const result = await db.query(
    "SELECT phone_number, agent_id FROM inbound_configs WHERE phone_number = $1",
    [phoneNumber]
  );

  reply.send({
    found: result.rows.length > 0,
    rows: result.rows
  });
});
}


