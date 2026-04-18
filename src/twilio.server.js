import Twilio from "twilio";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.production" });
import { SarvamAIClient } from "sarvamai";
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

// =============================================================================
// CONFIGURATION & INITIALIZATION
// =============================================================================

const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
const API_BASE_URL = 'https://callagent.zoptrix.com/api';

// Performance optimizations
const AUDIO_CHUNK_SIZE = 1600;
const MIN_SPEECH_DURATION_MS = 500;
const INTERRUPTION_THRESHOLD = 400;
const MAX_SILENCE_MS = 2000;
const STREAMING_BUFFER_SIZE = 320;

ffmpeg.setFfmpegPath(ffmpegPath);

// =============================================================================
// LANGUAGE DETECTION & MAPPING
// =============================================================================

const INDIAN_LANGUAGES = {
  'hi': 'hi-IN',  // Hindi
  'hi-IN': 'hi-IN',
  'kn': 'kn-IN',  // Kannada
  'kn-IN': 'kn-IN',
  'ta': 'ta-IN',  // Tamil
  'ta-IN': 'ta-IN',
  'te': 'te-IN',  // Telugu
  'te-IN': 'te-IN',
  'bn': 'bn-IN',  // Bengali
  'bn-IN': 'bn-IN',
  'ml': 'ml-IN',  // Malayalam
  'ml-IN': 'ml-IN',
  'mr': 'mr-IN',  // Marathi
  'mr-IN': 'mr-IN',
  'gu': 'gu-IN',  // Gujarati
  'gu-IN': 'gu-IN',
  'pa': 'pa-IN',  // Punjabi
  'pa-IN': 'pa-IN',
  'od': 'od-IN',  // Odia
  'od-IN': 'od-IN',
};


const SARVAM_LANGS = ["kn", "te", "mr", "gu", "bn", "ml", "pa","ta","hi","en"];

function shouldUseSarvam(languageCode) {
  if (!languageCode) return false;
  const base = languageCode.toLowerCase().split("-")[0];
  return SARVAM_LANGS.includes(base);
}

function normalizeLanguageCode(languageCode) {
  if (!languageCode) return null;
  const normalized = languageCode.toLowerCase();
  return INDIAN_LANGUAGES[normalized] || null;
}

function extractEmailFromSpeech(text) {
  if (!text) return null;

  const cleaned = text
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+dash\s+/g, "-")
    .replace(/\s+at\s+/g, "@")
.replace(/\s+dot\s+/g, ".")
.replace(/\s+/g, "")
.replace(/gmailcom$/, "gmail.com")

  const match = cleaned.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);

  return match ? match[0] : null;
}

// =============================================================================
// AUDIO PROCESSING UTILITIES
// =============================================================================

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

function calculateVolume(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const sample = buffer[i] - 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

async function mp3Base64ToPcm(mp3Base64) {
  const mp3Buffer = Buffer.from(mp3Base64, "base64");
  return new Promise((resolve, reject) => {
    const pcmChunks = [];
    const timeoutId = setTimeout(() => reject(new Error("FFmpeg timeout")), 5000);
    
    ffmpeg(Readable.from(mp3Buffer))
      .inputFormat("mp3")
      .audioChannels(1)
      .audioFrequency(8000)
      .audioCodec("pcm_s16le")
      .format("s16le")
      .on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      })
      .pipe()
      .on("data", chunk => pcmChunks.push(chunk))
      .on("end", () => {
        clearTimeout(timeoutId);
        resolve(Buffer.concat(pcmChunks));
      });
  });
}

function sendClearEvent(twilioWs, streamSid) {
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
  
  try {
    twilioWs.send(JSON.stringify({
      event: "clear",
      streamSid: streamSid
    }));
    
    for (let i = 0; i < 2; i++) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: "" }
      }));
    }
  } catch (err) {
    console.error("[clearEvent] Error:", err.message);
  }
}

// =============================================================================
// SARVAM TTS (INDIAN LANGUAGES)
// =============================================================================

class SarvamTTS {
  constructor(apiKey) {
    if (!apiKey) throw new Error("SARVAM_API_KEY missing");
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.model = "bulbul:v2";
  }

  async generateAndStream(text, options = {}, twilioWs, state) {
    if (!text?.trim() || state.interrupted || state.callEnded) return 0;

    const voice = options.voice || "karun";
    const pitch = options.pitch ?? 0.0;
    const pace = options.pace ?? 1.15;
    
    let languageCode = normalizeLanguageCode(options.languageCode) || "en-IN";

    let socket;
    try {
      if (state._pendingTTSSocket) {
        try {
          socket = await state._pendingTTSSocket;
          state._pendingTTSSocket = null;
          console.log("⚡ Reusing pre-warmed Sarvam socket");
        } catch (e) {
          socket = null;
        }
      }

     // REPLACE WITH:
      const isReused = !!socket;

      if (!socket) {
        socket = await this.client.textToSpeechStreaming.connect({
          model: this.model,
          send_completion_event: true,
        });
        await socket.waitForOpen();
      }

      if (!isReused) {
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
      } else {
        console.log(`✅ Sarvam Config: skipped (pre-warmed socket already configured)`);
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

  async preOpenSocket(options = {}) {
  const socket = await this.client.textToSpeechStreaming.connect({
    model: this.model,
    send_completion_event: true,
  });
  await socket.waitForOpen();
  // send config immediately
  socket.socket.send(JSON.stringify({
    type: "config",
    data: {
      target_language_code: normalizeLanguageCode(options.languageCode) || "en-IN",
      speaker: options.voice || "karun",
      pitch: 0.0, pace: 1.15,
      output_audio_codec: "mulaw",
      speech_sample_rate: 8000,
      min_buffer_size: 30,
      max_chunk_length: 100
    }
  }));
  return socket; // caller stores this and passes it to generateAndStream
}
}

// =============================================================================
// ELEVENLABS TTS (GLOBAL LANGUAGES)
// =============================================================================

// class ElevenLabsTTS {
//   constructor(apiKey) {
//     if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing");
//     this.apiKey = apiKey;
//     this.baseUrl = "https://api.elevenlabs.io/v1";
//   }

//   async generateAndStream(text, options = {}, twilioWs, state) {
//     if (!text?.trim() || state.interrupted || state.callEnded) return 0;

//     const voiceId = options.voiceId || "FGY2WhTYpPnrIDTdsKH5";
//     const speed = options.speed ?? 1.2;
//     const stability = options.stability ?? 1.0;
//     const similarityBoost = options.similarityBoost ?? 1.0;

//     try {
//       console.log(`✅ ElevenLabs Config: voice=${voiceId}, speed=${speed}`);

//       const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}/stream`, {
//         method: 'POST',
//         headers: {
//           'Accept': 'audio/mpeg',
//           'Content-Type': 'application/json',
//           'xi-api-key': this.apiKey
//         },
//         body: JSON.stringify({
//           text: text,
//           model_id: "eleven_turbo_v2_5",
//           voice_settings: {
//             stability: stability,
//             similarity_boost: similarityBoost,
//             speed: speed
//           }
//         })
//       });

//       // if (!response.ok) {
//       //   throw new Error(`ElevenLabs API error: ${response.status}`);
//       // }
//       if (!response.ok) {
//   let rawBody = "";
//   let jsonBody = null;

//   try {
//     rawBody = await response.text();
//     try {
//       jsonBody = JSON.parse(rawBody);
//     } catch (_) {}
//   } catch (_) {}

//   console.error("❌ ElevenLabs API ERROR (FULL DUMP)");
//   console.error("Status:", response.status);
//   console.error("Status Text:", response.statusText);
//   console.error("URL:", response.url);
//   console.error("Headers:", Object.fromEntries(response.headers.entries()));
//   console.error("Raw Body:", rawBody);
//   if (jsonBody) console.error("Parsed JSON:", jsonBody);

//   // IMPORTANT: throw AFTER logging
//   throw new Error(`ElevenLabs API error ${response.status}`);
// }


//       const reader = response.body.getReader();
//       let totalBytes = 0;
//       let audioBuffer = Buffer.alloc(0);

//       while (true) {
//         const { done, value } = await reader.read();
        
//         if (done || state.interrupted || state.callEnded) break;

//         if (value) {
//           audioBuffer = Buffer.concat([audioBuffer, Buffer.from(value)]);

//           // Process in chunks
//           while (audioBuffer.length >= 4096) {
//             const chunk = audioBuffer.slice(0, 4096);
//             audioBuffer = audioBuffer.slice(4096);

//             try {
//               const pcm = await mp3Base64ToPcm(chunk.toString('base64'));
//               const mulaw = linear16ToMulaw(pcm);

//               if (!state.interrupted && !state.callEnded && twilioWs.readyState === WebSocket.OPEN) {
//                 twilioWs.send(JSON.stringify({
//                   event: "media",
//                   streamSid: state.streamSid,
//                   media: {
//                     track: "outbound",
//                     payload: mulaw.toString("base64")
//                   }
//                 }));
//                 totalBytes += mulaw.length;
//               }
//             } catch (e) {
//               console.error("[ElevenLabs conversion error]", e.message);
//             }
//           }
//         }
//       }

//       // Process remaining buffer
//       if (audioBuffer.length > 0 && !state.interrupted && !state.callEnded) {
//         try {
//           const pcm = await mp3Base64ToPcm(audioBuffer.toString('base64'));
//           const mulaw = linear16ToMulaw(pcm);

//           if (twilioWs.readyState === WebSocket.OPEN) {
//             twilioWs.send(JSON.stringify({
//               event: "media",
//               streamSid: state.streamSid,
//               media: {
//                 track: "outbound",
//                 payload: mulaw.toString("base64")
//               }
//             }));
//             totalBytes += mulaw.length;
//           }
//         } catch (e) {
//           console.error("[ElevenLabs final chunk error]", e.message);
//         }
//       }

//       return totalBytes;
//     } catch (error) {
//       // console.error("[ElevenLabs TTS] Error:", error.message);
//       // return 0;
//        console.error("🔥 [ElevenLabs TTS] Fatal Error");
//   console.error("Message:", error.message);
//   console.error("Stack:", error.stack);
//   return 0;
//     }
//   }
// }

class ElevenLabsTTS {
  constructor(apiKey) {
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing");
    this.apiKey = apiKey;
    this.baseUrl = "https://api.elevenlabs.io/v1";
  }

  async generateAndStream(text, options = {}, twilioWs, state) {
    if (!text?.trim() || state.interrupted || state.callEnded) return 0;

    const voiceId = options.voiceId || "FGY2WhTYpPnrIDTdsKH5";
    const speed = options.speed ?? 1.2;
    const stability = options.stability ?? 1.0;
    const similarityBoost = options.similarityBoost ?? 1.0;

    try {
      console.log(`✅ ElevenLabs Config: voice=${voiceId}, speed=${speed}`);

      const response = await fetch(
        // ✅ Use PCM output directly — no MP3 decode needed!
        `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=pcm_8000`,
        {
          method: "POST",
          headers: {
            Accept: "audio/wav",
            "Content-Type": "application/json",
            "xi-api-key": this.apiKey,
          },
          body: JSON.stringify({
            text: text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: {
              stability: stability,
              similarity_boost: similarityBoost,
              speed: speed,
            },
          }),
           signal: options.signal 
        }
      );

      if (!response.ok) {
        let rawBody = "";
        try { rawBody = await response.text(); } catch (_) {}
        console.error("❌ ElevenLabs API ERROR");
        console.error("Status:", response.status, response.statusText);
        console.error("Body:", rawBody);
        throw new Error(`ElevenLabs API error ${response.status}: ${rawBody}`);
      }
      console.time("TTS_FIRST_BYTE");
      const reader = response.body.getReader();
      let totalBytes = 0;

      // ✅ PCM comes in as raw 16-bit LE at 8000 Hz — matches what Twilio needs
      // Just accumulate and convert to mulaw, no ffmpeg required
      let pcmBuffer = Buffer.alloc(0);
      const CHUNK_SAMPLES = 160; // 20ms of audio at 8000 Hz
      const CHUNK_BYTES = CHUNK_SAMPLES * 2; // 16-bit = 2 bytes per sample

      while (true) {
        if (state.interrupted) {
  console.log("🛑 HARD STOP TTS LOOP");
  break;
}
        const { done, value } = await reader.read();

        if (state.interrupted || state.callEnded) {
          console.log("[ElevenLabs] Interrupted, stopping stream");
          break;
        }

        if (value) {
          pcmBuffer = Buffer.concat([pcmBuffer, Buffer.from(value)]);

          // ✅ Send complete 20ms PCM frames as mulaw to Twilio
          while (pcmBuffer.length >= CHUNK_BYTES) {
            const frame = pcmBuffer.slice(0, CHUNK_BYTES);
            pcmBuffer = pcmBuffer.slice(CHUNK_BYTES);

            const mulaw = linear16ToMulaw(frame);

            if (
              !state.interrupted &&
              !state.callEnded &&
              twilioWs.readyState === WebSocket.OPEN
            ) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid: state.streamSid,
                  media: {
                    track: "outbound",
                    payload: mulaw.toString("base64"),
                  },
                })
              );
              totalBytes += mulaw.length;
            }
          }
        }

        if (done) break;
      }

      // ✅ Flush remaining PCM (last partial frame)
      if (
        pcmBuffer.length > 0 &&
        !state.interrupted &&
        !state.callEnded &&
        twilioWs.readyState === WebSocket.OPEN
      ) {
        // Pad to even number of bytes if needed
        if (pcmBuffer.length % 2 !== 0) {
          pcmBuffer = Buffer.concat([pcmBuffer, Buffer.alloc(1)]);
        }
        const mulaw = linear16ToMulaw(pcmBuffer);
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: state.streamSid,
            media: {
              track: "outbound",
              payload: mulaw.toString("base64"),
            },
          })
        );
        totalBytes += mulaw.length;
      }

      return totalBytes;
    } catch (error) {
      console.error("🔥 [ElevenLabs TTS] Fatal Error:", error.message);
      console.error("Stack:", error.stack);
      return 0;
    }
  }
}

// =============================================================================
// TTS MANAGER (ROUTES TO CORRECT PROVIDER)
// =============================================================================

class TTSManager {
  constructor() {
    this.sarvamTTS = new SarvamTTS(process.env.SARVAM_API_KEY);
    this.elevenLabsTTS = new ElevenLabsTTS(process.env.ELEVENLABS_API_KEY);
  }

  async generateAndStream(text, options = {}, twilioWs, state) {
    const languageCode = options.languageCode || options.transcriberLanguage;
    
    // Determine which TTS to use based on language
    if (shouldUseSarvam(languageCode)) {
      console.log(`🎤 Using Sarvam TTS for language: ${languageCode}`);
      return await this.sarvamTTS.generateAndStream(text, {
        voice: options.sarvamVoice || options.voice || "karun",
        languageCode: languageCode,
        pitch: options.pitch ?? 0.0,
        pace: options.pace ?? 1.15
      }, twilioWs, state);
    } else {
      console.log(`🎤 Using ElevenLabs TTS for language: ${languageCode}`);
      return await this.elevenLabsTTS.generateAndStream(text, {
        voiceId: options.elevenLabsVoiceId || "FGY2WhTYpPnrIDTdsKH5",
        speed: options.elevenLabsSpeed ?? 1.2,
        stability: options.elevenLabsStability ?? 1.0,
        similarityBoost: options.elevenLabsSimilarityBoost ?? 1.0
      }, twilioWs, state);
    }
  }
}

// =============================================================================
// DEEPGRAM STT
// =============================================================================

class DeepgramSTT {
  constructor({ language, model }) {
    this.language = language;
    this.model = model;
    this.socket = null;
    this.ready = false;
    this.onTranscript = null;
    this.onInterruption = null;
    this.lastTranscriptTime = 0;
    this.lastFinalTranscript = "";
  }

  async connect() {
    this.ready = false;
    this.socket = await deepgram.listen.live({
      model: this.model,
      language: this.language,
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      smart_format: true,
      vad_events: true,
      endpointing: 100,
      utterance_end_ms: 1000,
    });

    this.socket.on(LiveTranscriptionEvents.Open, () => {
      this.ready = true;
      console.log("✅ Deepgram STT connected");
    });

   this.socket.on(LiveTranscriptionEvents.Transcript, (data) => {
  const text = data.channel?.alternatives?.[0]?.transcript;

  if (!text || !text.trim()) return;

  const cleaned = text.trim();

  // ============================================================
  // 🛑 INTERRUPTION (ONLY FOR INTERIM)
  // ============================================================
  if (!data.speech_final) {
    if (this.onInterruption) {
  this.onInterruption(cleaned);
    }
    return; // 🔥 VERY IMPORTANT (stop here for interim)
  }

  // ============================================================
  // ✅ FINAL TRANSCRIPT (ONLY ONCE)
  // ============================================================

  // ❌ prevent duplicate same text
  if (cleaned === this.lastFinalTranscript) return;

  this.lastFinalTranscript = cleaned;

  // ✅ send ONLY once
  if (this.onTranscript) {
    this.onTranscript(cleaned, true);
  }
});

    this.socket.on(LiveTranscriptionEvents.Error, (err) => {
      console.error("❌ Deepgram error:", err.message);
      this.ready = false;
    });

    this.socket.on(LiveTranscriptionEvents.Close, () => {
      console.warn("⚠️ Deepgram socket closed");
      this.ready = false;
    });
  }

  sendAudio(buffer) {
    if (this.socket && this.ready) {
      try {
        this.socket.send(buffer);
      } catch (err) {
        console.error("[STT] Send error:", err.message);
      }
    }
  }

  close() {
    if (this.socket) {
      try { this.socket.finish(); } catch {}
      this.socket = null;
      this.ready = false;
    }
  }
}

// =============================================================================
// AI & KNOWLEDGE BASE (keeping existing implementation)
// =============================================================================

// async function aiResponse(messages, model, temperature, maxTokens) {
//   try {
//     const stream = await openai.chat.completions.create({
//       model,
//       temperature,
//       max_tokens: maxTokens,
//       messages,
//       stream: true,
//     });

//     let fullMessage = "";
//     for await (const chunk of stream) {
//       const token = chunk.choices?.[0]?.delta?.content ?? "";
//       if (!token) continue;
//       const clean = token
//         .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
//         .replace(/[*_~`>#]/g, "")
//         .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
//       fullMessage += clean;
//     }
//     return fullMessage.trim();
//   } catch (err) {
//     console.error("[aiResponse] error:", err.message);
//     return "I apologize, but I'm having trouble processing that. Could you repeat?";
//   }
// }

async function aiResponse(messages, model, temperature, maxTokens, onPartial) {
  try {
    const stream = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
      stream: true,
    });

    let fullMessage = "";
    let partial = "";
    let sent = false;

    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content ?? "";
      if (!token) continue;

      const clean = token
        .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
        .replace(/[*_~`>#]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

      fullMessage += clean;
      partial += clean;

      // 🚀 SPEAK EARLY
      if (!sent && partial.length > 5 && onPartial) {
        sent = true;
        onPartial(partial);
      }
    }

    return fullMessage.trim();
  } catch (err) {
    console.error("[aiResponse] error:", err.message);
    return "Sorry, could you repeat?";
  }
}

const embeddingCache = new Map();

async function embedText(text) {
  const cacheKey = text.toLowerCase().trim();
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey);
  
  try {
    const embed = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    const result = embed.data[0].embedding;
    embeddingCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Embedding error:', error.message);
    return null;
  }
}

// async function preFetchAgentKnowledge(agentId) {
//   try {
//     const queryEmbedding = await embedText("general information about products and services");
//     if (!queryEmbedding) return [];
// console.log("Agent ID:", agentId);
//     const results = await index.query({
//       vector: queryEmbedding,
//       topK: 50,
//       includeMetadata: true,
//       filter: { agent_id: agentId },
//     });
// console.log("Pinecone matches:", results.matches.length);
//     return results.matches.map(match => ({
//       content: match.metadata.content,
//       _lc: (match.metadata.content || "").toLowerCase(),
//     }));
//   } catch (error) {
//     console.error('Error pre-fetching knowledge:', error.message);
//     return [];
//   }
// }

async function preFetchAgentKnowledge(agentId) {
  try {
    const queryEmbedding = await embedText("general information about products and services");
    if (!queryEmbedding) return [];

    // ✅ GET KB IDs
    const kbResult = await db.query(
      `SELECT knowledge_base_id 
       FROM agent_knowledge_map 
       WHERE agent_id = $1`,
      [agentId]
    );

    const kbIds = kbResult.rows.map(r => r.knowledge_base_id);

    console.log("Agent ID:", agentId);
    console.log("KB IDs:", kbIds);

    if (kbIds.length === 0) {
      console.log("⚠️ No KB linked to agent");
      return [];
    }

    // ✅ QUERY PINECONE
    const results = await index.query({
      vector: queryEmbedding,
      topK: 50,
      includeMetadata: true,
      filter: {
        knowledge_base_id: { $in: kbIds }
      }
    });

    console.log("Pinecone matches:", results.matches.length);

    return results.matches.map(match => ({
      content: match.metadata.content,
      _lc: (match.metadata.content || "").toLowerCase(),
    }));

  } catch (error) {
    console.error('Error pre-fetching knowledge:', error.message);
    return [];
  }
}

async function getRelevantChunks(userText, agentId, preloadedChunks, topK = 3) {
  try {
    if (!preloadedChunks || preloadedChunks.length === 0) return [];

    const queryLower = userText.toLowerCase();
    const keywords = ['monospear', 'product', 'service', 'pricing', 'feature', 'benefit', 'trial', 'demo'];

    const scored = preloadedChunks.map(chunk => {
      const text = chunk._lc || (chunk.content || "").toLowerCase();
      let score = 0;

      for (const kw of keywords) {
        if (queryLower.includes(kw) && text.includes(kw)) {
          score += 2;
        } else if (text.includes(kw)) {
          score += 1;
        }
      }

      if (score === 0) {
        const qTokens = new Set(queryLower.split(/\W+/).filter(Boolean));
        const tTokens = new Set(text.split(/\W+/).filter(Boolean));
        let overlap = 0;
        for (const t of qTokens) {
          if (tTokens.has(t)) overlap++;
        }
        score = overlap;
      }

      return { content: chunk.content, score };
    });

    // return scored
    //   .sort((a, b) => b.score - a.score)
    //   .slice(0, topK)
    //   .filter(c => c.score > 0 || topK === Infinity);
    return scored
  .sort((a, b) => b.score - a.score)
  .slice(0, topK); 
  
  } catch (error) {
    console.error('Error getting relevant knowledge:', error.message);
    return preloadedChunks.slice(0, topK);
  }
}

// =============================================================================
// CALENDAR FUNCTIONS (keeping existing implementation)
// =============================================================================

function detectCustomerTimezone(location) {
  const locationTimezones = {
    'London': 'Europe/London',
    'Manchester': 'Europe/London',
    'Brighton': 'Europe/London',
    'New York': 'America/New_York',
    'Los Angeles': 'America/Los_Angeles',
    'Paris': 'Europe/Paris',
    'Berlin': 'Europe/Berlin',
    'Tokyo': 'Asia/Tokyo',
    'Mumbai': 'Asia/Kolkata',
    'Delhi': 'Asia/Kolkata',
    'Bangalore': 'Asia/Kolkata',
    'Hyderabad': 'Asia/Kolkata',
    'Kolkata': 'Asia/Kolkata',
    'Chennai': 'Asia/Kolkata',
    'Sydney': 'Australia/Sydney'
  };
  return locationTimezones[location] || 'UTC';
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
    console.error('Error converting timezone:', error.message);
    return new Date(datetimeString + 'Z');
  }
}

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
    console.error('Error formatting time:', error.message);
    return utcDatetime.toString();
  }
}

async function getAgentCalendarConfig(agentId) {
  try {
    const response = await fetch(`${API_BASE_URL}/${agentId}/calendar-config`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
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
    console.error("Error fetching calendar config:", error.message);
    return null;
  }
}

async function saveExtractedDetailsWithTimezone(callSid, extractedDetails, calendarConfig) {
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

    const response = await fetch(`${API_BASE_URL}/save-extracted-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const savedDetails = await response.json();

    const meetPayload = {
      duration: extractedDetails.duration || 30,
      subject: extractedDetails.subject,
      description: extractedDetails.description,
      extractedId: savedDetails.data.id || 37,
      callId: callSid,
      contactId: extractedDetails.contactId || null
    };

    const meetResponse = await fetch(`${API_BASE_URL}/schedule/meet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meetPayload)
    });

    if (!meetResponse.ok) throw new Error(`Meeting API failed: ${meetResponse.statusText}`);

    return savedDetails;
  } catch (error) {
    console.error('❌ Error in save and schedule flow:', error.message);
    throw error;
  }
}

// =============================================================================
// SYSTEM PROMPT CREATION
// =============================================================================

function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
  const currentTime = new Date().toISOString();
  const agentTimezone = calendarConfig?.effective_timezone || 'UTC';
  
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

  return `${baseSystemPrompt}

You are a helpful AI assistant. Current UTC time: ${currentTime}. Current time in your timezone (${agentTimezone}): ${agentLocalTime}.

**Core Behavior:**
- Be concise, natural, and conversational
- Keep responses short (2-3 sentences maximum)
- Respond quickly - speed is critical
- Only provide essential information
- Avoid long explanations unless specifically asked

**Identity Rule:**
- Introduce yourself ONLY once at the beginning of the call.
- Do NOT repeat your name unless asked.


**Email Collection:**
When collecting emails, be efficient:
1. Ask them to spell it out clearly
2. Confirm once: "So that's [email], correct?"
3. Move on immediately after confirmation

**Meeting Scheduling:**
- Be quick and efficient
- Confirm details once and proceed
- Don't over-explain

**Remember:**
- Speed and brevity are key
- Natural conversation flow
- Quick confirmations
- Move forward efficiently
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
      description: "End the call politely",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for ending" },
          message: { type: "string", description: "Final message" }
        },
        required: ["reason", "message"]
      }
    },
  ];

  if (calendarConfig && calendarConfig.calendar_access_token) {
    baseFunctions.push({
      name: "schedule_meeting",
      description: "Schedule a meeting",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string" },
          datetime: { type: "string", description: "UTC format YYYY-MM-DD HH:mm:ss" },
          location: { type: "string", enum: ["London", "Manchester", "Brighton"] },
          purpose: { type: "string", default: "discovery call" },
          timezone: { type: "string" }
        },
        required: ["email", "datetime", "location"]
      }
    });
  }

  return baseFunctions;
}

// =============================================================================
// FUNCTION HANDLERS
// =============================================================================

async function handleQuestionAnswer(query, settings) {
  try {
    const relevantChunks = await getRelevantChunks(query, settings.agentId, settings.knowledgeChunks || [], 2);

    if (relevantChunks.length > 0) {
      return {
        success: true,
        answer: relevantChunks[0].content,
        source: "knowledge_base"
      };
    }
    
    return {
      success: true,
      answer: "I don't have specific information about that. Let me help you with scheduling instead.",
      source: "fallback"
    };
  } catch (error) {
    console.error('Q&A error:', error.message);
    return { error: "Failed to process question" };
  }
}

async function handleScheduleMeeting(parameters, callSid, settings) {
  try {
    let { email, datetime, location, purpose = "discovery call", timezone: customerTimezone } = parameters;
    email = email?.trim().toLowerCase();

    if (!settings.calendarConfig || !settings.calendarConfig.calendar_access_token) {
      return {
        success: false,
        message: "I apologize, but I'm unable to schedule meetings at the moment."
      };
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: "Please provide a valid email address." };
    }

    const detectedCustomerTimezone = customerTimezone || detectCustomerTimezone(location);
    const agentTimezone = settings.calendarConfig.effective_timezone || 'IST';

    let meetingDateUTC;
    if (!datetime) {
      return { success: false, message: "Please provide a date and time." };
    }
    
    if (datetime.includes("T")) {
      meetingDateUTC = DateTime.fromISO(datetime, { zone: 'UTC' });
    } else {
      meetingDateUTC = DateTime.fromFormat(datetime, "yyyy-MM-dd HH:mm:ss", { zone: 'UTC' });
    }

    if (!meetingDateUTC.isValid) {
      return { success: false, message: "Please provide a valid date and time format." };
    }

    if (meetingDateUTC <= DateTime.utc().plus({ minutes: 1 })) {
      return { success: false, message: "Please choose a future time." };
    }

    const formattedDatetime = meetingDateUTC.toFormat("yyyy-MM-dd HH:mm:ss");

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
    };

    await saveExtractedDetailsWithTimezone(callSid, {
      email,
      appointmentTime: formattedDatetime,
      location,
      purpose,
      hasConfirmation: true,
      customerTimezone: detectedCustomerTimezone,
      agentTimezone,
      agentId: settings.agentId,
      meetingId: `meeting_${Date.now()}`
    }, settings.calendarConfig);

    const customerTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), detectedCustomerTimezone);

    return { 
      success: true, 
      message: `Perfect! Meeting scheduled for ${customerTime}. You'll receive confirmation at ${email}.`
    };

  } catch (error) {
    console.error("Error scheduling:", error.message);
    return { success: false, message: "I encountered an error. Could you try again?" };
  }
}

async function handleHangUp(reason, callSid, callSettings, sessions, streamToCallMap) {
  try {
    const settings = callSettings.get(callSid);
    callSettings.delete(callSid);
    sessions.delete(callSid);
    
    for (const [streamSid, sid] of streamToCallMap.entries()) {
      if (sid === callSid) {
        streamToCallMap.delete(streamSid);
      }
    }

    console.log(`📞 Call ${callSid} ended: ${reason || 'user ended'}`);
    return {
      success: true,
      message: "Thank you for your time. Goodbye!",
      action: "call_ended",
      reason: reason || 'user ended'
    };
  } catch (error) {
    console.error("Error ending call:", error.message);
    return { error: "Failed to end call" };
  }
}

// =============================================================================
// MAIN SPEECH FUNCTION
// =============================================================================

const ttsManager = new TTSManager();

async function speakText(text, state, twilioWs, ttsOptions = {}) {
  if (state.callEnded || !twilioWs || twilioWs.readyState !== WebSocket.OPEN || !text?.trim()) {
    state.botSpeaking = false;
    return;
  }
// ✅ RESET ONLY WHEN NEW SPEECH STARTS
state.interrupted = false;
state.botSpeaking = true;

// 🔥 CREATE CONTROLLER HERE
state.ttsAbortController = new AbortController();

  try {
    // sendClearEvent(twilioWs, state.streamSid);
    // await new Promise(r => setTimeout(r, 10));

  await ttsManager.generateAndStream(
  text,
  {
    ...ttsOptions,
    signal: state.ttsAbortController?.signal // 🔥 ADD THIS
  },
  twilioWs,
  state
);

    if (state.interrupted) {
      sendClearEvent(twilioWs, state.streamSid);
    }
  } catch (err) {
    console.error("[SPEAK ERROR]", err.message);
  } finally {
    state.botSpeaking = false;
    state.lastBotSpeechEnd = Date.now();
  }
}


async function processTurn(userText, state, twilioWs, callSettings, sessions, streamToCallMap) {

  if (!userText?.trim()) return;
  if (state.callEnding || state.callEnded) return;
  const streamSid = state.streamSid;
  const callSid = streamToCallMap.get(streamSid);
  const settings = callSettings.get(callSid);
  console.log(`📚 [PROCESS TURN] KB chunks in settings: ${settings.knowledgeChunks?.length || 0} | AgentId: ${settings.agentId}`);
  if (!settings) {
    console.warn(`[processTurn] No settings for ${streamSid}`);
    return;
  }

  // if (state.botSpeaking) {
  //   await new Promise(r => setTimeout(r, 10));
  // }

  const cleaned = userText.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);

  // 🗣️ Always log what user said
  console.log(`🗣️ USER SAID: "${cleaned}"`);
  
  if (cleaned.length < 5 || words.length < 2) return;

  // ============================================================================
  // ⚠️ ESCALATION STEPS 2 & 3 MUST RUN BEFORE INTENT DETECTION
  // Otherwise "no" / "yes" / email text gets misclassified as new escalation
  // ============================================================================

  // ============================================================================
  // 📧 ESCALATION — STEP 2: Collect email (with AI extraction)
  // ============================================================================

  if (state.awaitingEscalationEmail && !state.awaitingEmailConfirmation) {


    let emailInput = cleaned;

    try {
      // STEP 1: Transliterate Kannada/Indian phonetics to English
      const translitRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 150,
        messages: [
          {
            role: "system",
            content: `You are a phonetic transliterator. The user is spelling out an email address aloud in Kannada/Hindi/Tamil/Telugu phonetics. Convert ALL words to their English phonetic equivalents.

NUMBER words → digits:
- ವನ್/ಒನ್/one = 1, ಟೂ/two = 2, ತ್ರೀ/three = 3, ಫೋರ್/four = 4
- ಫೈ/ಫೈಿ/five = 5, ಸಿಕ್ಸ್/six = 6, ಸೆವೆನ್/seven = 7
- ಎಯ್ಟ್/eight = 8, ನೈನ್/nine = 9, ಝೀರೋ/zero = 0

@ words → "at":
- ಆಟ್/ಎಟ್/ಆಟ/at the rate = at

DOT words → "dot":
- ಡಾಟ್/ನೌಟ್/ಡೌಟ್/ಡಾಟ/point = dot

COM words → "com":
- ಕೊಂ/ಕೋವ್/ಕಾಮ್ = com

GMAIL words → "gmail":
- ಜಿಮೇಲ್/ಎಂಜಿ ಮೈಲ್/ಎಂಜಿನೇಯಲ್/G mail = gmail

LETTER spellings → single letter:
- ಎ=a, ಬಿ=b, ಸಿ=c, ಡಿ=d, ಇ=e, ಎಫ್=f, ಜಿ=g, ಎಚ್=h, ಐ=i
- ಜೆ=j, ಕೆ=k, ಎಲ್=l, ಎಂ=m, ಎನ್=n, ಓ=o, ಪಿ=p, ಕ್ಯೂ=q
- ಆರ್=r, ಎಸ್=s, ಟಿ=t, ಯೂ=u, ವಿ=v, ಡಬ್ಲ್ಯೂ=w, ಎಕ್ಸ್=x, ವೈ=y, ಝೆಡ್=z

RULES:
- Ignore filler words: ನನ್ನ ಇಮೇಲ್, ಹೇಳ್ಕೊಳ, ಇದು, my email is, etc.
- Return ONLY the transliterated English version, nothing else

Examples:
"ಶಕ್ತಿ ವನ್ ಫೈ ಫೋರ್ ಆಟ್ ಜಿಮೇಲ್ ಡಾಟ್ ಕೊಂ" → "shakti 1 5 4 at gmail dot com"
"ಸಪ್ಪಿಸಿ ಟಿ ಒನ್ ಫೈ ಫೋರ್ ಎಂಜಿ ಮೈಲ್ ನೌಟ್ ಕೋವ್" → "sappisi t 1 5 4 at gmail dot com"
"ಶಕ್ತಿ ಶಕ್ತಿ ವನ್ ಫೈ ಫೋರ್ ಎಂಜಿನೇಯಲ್ ಡೌಟ್ ಕೊಂ" → "shakti shakti 1 5 4 at gmail dot com"`
          },
          { role: "user", content: cleaned }
        ]
      });

      const transliterated = translitRes.choices[0].message.content.trim().toLowerCase();
      console.log(`🔤 Transliterated: "${cleaned}" → "${transliterated}"`);

      // STEP 2: Extract email from transliterated English
      const extractRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 100,
        messages: [
          {
            role: "system",
            content: `Extract and return ONLY the email address from this English text.

Rules:
- "at" or "@" = @
- "dot" or "." = .
- consecutive letters/numbers = join them (e.g. "s h a k t i" = "shakti", "1 5 4" = "154")
- Return ONLY the email like: name@domain.com
- If no valid email, return: NONE

Examples:
"shakti 1 5 4 at gmail dot com" → shakti154@gmail.com
"sappisi t 1 5 4 at gmail dot com" → sappisit154@gmail.com
"shakti shakti 1 5 4 at gmail dot com" → shaktishakti154@gmail.com
"john dot smith at gmail dot com" → john.smith@gmail.com
"hello how are you" → NONE`
          },
          { role: "user", content: transliterated }
        ]
      });

      emailInput = extractRes.choices[0].message.content.trim().toLowerCase();
      console.log(`🌍 Email extracted by AI: "${cleaned}" → "${emailInput}"`);

    } catch (err) {
      console.error("Translation error for email:", err.message);
    }

    console.log("📧 EMAIL BUFFER:", cleaned);
    console.log("📧 EXTRACTED EMAIL:", emailInput);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    if (emailInput !== "none" && emailRegex.test(emailInput)) {

      state.pendingEmail = emailInput;
      state.awaitingEmailConfirmation = true;
      state.awaitingEscalationEmail = false;

      await speakText(
        `Just to confirm, your email is ${emailInput}. Is that correct?`,
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice,
          pace: 1.15
        }
      );

    } else {

      await speakText(
        "I couldn't detect a valid email address. Could you please repeat your email?",
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice
        }
      );
    }

    return;
  }

  // ============================================================================
  // ✅ ESCALATION — STEP 3: Confirm email (with AI translation)
  // ============================================================================

  if (state.awaitingEmailConfirmation) {

    let confirmText = cleaned.toLowerCase();

    try {
      const confirmRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content: `Translate to English. Return ONLY one word: yes, no, or unclear.`
          },
          { role: "user", content: cleaned }
        ]
      });
      confirmText = confirmRes.choices[0].message.content.trim().toLowerCase();
      console.log(`🌍 Confirmation translated: "${cleaned}" → "${confirmText}"`);
    } catch (err) {
      console.error("Confirmation translation error:", err.message);
    }

    if (confirmText.includes("yes") || confirmText.includes("correct")) {

      const callSid = streamToCallMap.get(state.streamSid);
      const confirmedEmail = state.pendingEmail;

      console.log("✅ EMAIL CONFIRMED:", confirmedEmail);

      // Reset state immediately before anything else
      state.awaitingEmailConfirmation = false;
      state.awaitingEscalationEmail = false;
      state.pendingEmail = null;

      // Speak immediately — don't await DB
      speakText(
        `Thank you. Our support team will contact you shortly at ${confirmedEmail}.`,
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice
        }
      ).catch(err => console.error("speakText error:", err.message));

      // Fire-and-forget DB update in background
      db.query(
        `UPDATE campaign_logs
         SET escalation_status = TRUE,
             escalation_email = $1
         WHERE call_id = $2`,
        [confirmedEmail, callSid]
      ).then(() => {
        console.log("📥 Email stored in DB:", confirmedEmail);
      }).catch(err => {
        console.error("❌ DB update failed:", err.message);
      });

      return;

    } else if (confirmText.includes("no") || confirmText.includes("wrong") || confirmText.includes("incorrect")) {

      console.log("❌ EMAIL REJECTED BY USER");

      state.pendingEmail = null;
      state.awaitingEmailConfirmation = false;
      state.awaitingEscalationEmail = true;

      await speakText(
        "Sorry about that. Could you repeat your email slowly?",
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice
        }
      );

      return;
    }

    return;
  }

  // ============================================================================
  // 🚨 ESCALATION — STEP 1: Detect intent (only runs in normal conversation)
  // ============================================================================

  // const intent = await detectIntent(cleaned);

  // if (intent === "escalation" && !state.awaitingEscalationEmail) {

  //   console.log("🚨 Escalation intent detected");
  //   state.awaitingEscalationEmail = true;

  //   await speakText(
  //     "Sure, I can connect you with our support team. Could you please provide your email address?",
  //     state,
  //     twilioWs,
  //     {
  //       transcriberLanguage: state.transcriberLanguage,
  //       languageCode: state.transcriberLanguage,
  //       sarvamVoice: state.sarvamVoice,
  //       voice: state.sarvamVoice,
  //       elevenLabsVoiceId: state.elevenLabsVoiceId,
  //       elevenLabsSpeed: state.elevenLabsSpeed,
  //       elevenLabsStability: state.elevenLabsStability,
  //       elevenLabsSimilarityBoost: state.elevenLabsSimilarityBoost,
  //       pace: 1.15
  //     }
  //   );
  //   return;
  // }

  // ============================================================================
  // 🚨 ESCALATION — STEP 1: Detect intent (only runs in normal conversation)
  // ============================================================================

  // const intent = await detectIntent(cleaned);

  // if (intent === "escalation" && !state.awaitingEscalationEmail) {

  //   console.log("🚨 Escalation intent detected");

  //   // Check if any human agent is available
  //   const agent = await findAvailableAgent(settings.agentId);

  //   if (agent) {
  //     // ✅ AGENT AVAILABLE — do live transfer
  //     console.log(`📞 Agent found: ${agent.name} (${agent.phone_number})`);
  //     // Tell customer
  //     await speakText(
  //       "Please hold, I am connecting you to our support team right now.",
  //       state,
  //       twilioWs,
  //       {
  //         transcriberLanguage: state.transcriberLanguage,
  //         languageCode: state.transcriberLanguage,
  //         sarvamVoice: state.sarvamVoice,
  //         voice: state.sarvamVoice,
  //         elevenLabsVoiceId: settings.elevenLabsVoiceId,
  //         elevenLabsSpeed: settings.elevenLabsSpeed,
  //         elevenLabsStability: settings.elevenLabsStability,
  //         elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
  //         pace: 1.15
  //       }
  //     );
  //      state.transferTo = agent.phone_number;
  //     state.transferFrom = settings.twilioPhoneNumber;
  //     // Keep sending silence to prevent Twilio from dropping call
  //     // while we make the transfer API call
  //     const silenceInterval = setInterval(() => {
  //       if (twilioWs.readyState === WebSocket.OPEN) {
  //         twilioWs.send(JSON.stringify({
  //           event: "media",
  //           streamSid: state.streamSid,
  //           media: {
  //             payload: Buffer.alloc(160, 0xff).toString("base64")
  //           }
  //         }));
  //       }
  //     }, 20);

  //     // Step 1 — Transfer first immediately after speaking
  //     const transferred = await transferCall(
  //       callSid,
  //       agent.phone_number,
  //       settings.twilioAccountSid,
  //       settings.twilioAuthToken,
  //       settings.twilioPhoneNumber,
  //       settings.isInbound || false
  //     );

  //   if (!transferred) {
  //       // Transfer failed — fall back to email
  //       clearInterval(silenceInterval);
  //       console.log("⚠️ Transfer failed → falling back to email collection");
  //       state.awaitingEscalationEmail = true;
  //       await speakText(
  //         "I'm sorry, I couldn't connect you right now. Could you please provide your email and we will call you back?",
  //         state,
  //         twilioWs,
  //         {
  //           transcriberLanguage: state.transcriberLanguage,
  //           languageCode: state.transcriberLanguage,
  //           sarvamVoice: state.sarvamVoice,
  //           pace: 1.15
  //         }
  //       );
  //       return;
  //     }
  //     // Step 2 — Transfer succeeded → mark agent busy
  //     await markAgentBusy(agent.id, callSid);
  //     // Step 3 — Log in background
  //     db.query(`
  //       INSERT INTO call_routing_logs
  //         (call_sid, routing_agent_id, agent_phone, status, escalation_email)
  //       VALUES ($1, $2, $3, 'initiated', $4)
  //     `, [callSid, agent.id, agent.phone_number, state.pendingEmail || null])
  //     .catch(err => console.error("❌ routing log error:", err.message));

  //    // Step 4 — Stop silence interval
  //     clearInterval(silenceInterval);
  //     // Step 5 — Stop AI completely
  //     console.log("✅ Transfer successful — AI exiting");
  //     state.callEnding = true;
  //     state.botSpeaking = false;
  //     state.interrupted = true;
  //     state.workflowEngine = null;
  //     state.currentNode = null;

  //     // Step 6 — Close WebSocket after delay
  //     // to allow Twilio to fully take over the call
  //     setTimeout(() => {
  //       try {
  //         if (twilioWs.readyState === WebSocket.OPEN) {
  //           twilioWs.close();
  //         }
  //       } catch (e) {}
  //     }, 2000);
  //   } else {
  //     // ❌ NO AGENT AVAILABLE — fall back to email collection
  //     console.log("⚠️ No agents available → collecting email");
  //     state.awaitingEscalationEmail = true;
  //     await speakText(
  //       "All our agents are busy right now. Could you please provide your email address and we will call you back shortly?",
  //       state,
  //       twilioWs,
  //       {
  //         transcriberLanguage: state.transcriberLanguage,
  //         languageCode: state.transcriberLanguage,
  //         sarvamVoice: state.sarvamVoice,
  //         voice: state.sarvamVoice,
  //         elevenLabsVoiceId: settings.elevenLabsVoiceId,
  //         elevenLabsSpeed: settings.elevenLabsSpeed,
  //         elevenLabsStability: settings.elevenLabsStability,
  //         elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
  //         pace: 1.15
  //       }
  //     );
  //   }
  //   return;
  // }

  // const intent = await detectIntent(cleaned);

const [intent, relevantChunks] = await Promise.all([
    detectIntent(cleaned),
    (settings.knowledgeChunks?.length > 0)
      ? getRelevantChunks(cleaned, settings.agentId, settings.knowledgeChunks, 3)
      : Promise.resolve([])
  ]);

  if (intent === "escalation" && !state.awaitingEscalationEmail) {

    console.log(`🚨 Escalation intent detected (attempt ${state.escalationAttempts + 1})`);

    state.escalationAttempts += 1;

    if (state.escalationAttempts === 1) {
      // ============================================================
      // FIRST TIME — AI tries to help instead of transferring
      // ============================================================
      console.log("🤖 First escalation — AI trying to help first");

      // Get AI to respond helpfully to what the user said
      const conversation = sessions.get(callSid) || [];

      // let relevantChunks = [];
      // if (settings.knowledgeChunks && settings.knowledgeChunks.length > 0) {
      //   relevantChunks = await getRelevantChunks(cleaned, settings.agentId, settings.knowledgeChunks, 2);
      // }

      const kbContext = relevantChunks.length > 0
        ? relevantChunks.map(c => c.content).join('\n\n')
        : "";

      const agentPrompt = settings.agentPrompt || settings.systemPrompt || "";

      const systemPrompt = `${agentPrompt}

${kbContext ? `KNOWLEDGE:\n${kbContext}\n` : ''}

The user wants to speak to a human agent. Before transferring, try to resolve their issue yourself.
- Acknowledge their request warmly
- Ask what specific problem they need help with
- Try your best to solve it
- Keep response under 40 words`.trim();

      const messages = [
        { role: "system", content: systemPrompt },
        ...conversation.slice(-6),
        { role: "user", content: cleaned }
      ];

      let botReply;
      try {
        // botReply = await aiResponse(
        //   messages,
        //   settings.aiModel || "gpt-4o-mini",
        //   settings.temperature ?? 0.7,
        //   100
        // );
//         botReply = await aiResponse(
//   messages,
//   settings.aiModel || "gpt-4o-mini",
//   settings.temperature ?? 0.7,
//   60,
//   (partial) => {
//     speakText(partial, state, twilioWs, {
//       transcriberLanguage: settings.transcriberLanguage,
//       languageCode: settings.transcriberLanguage,
//       sarvamVoice: settings.sarvamVoice,
//       elevenLabsVoiceId: settings.elevenLabsVoiceId,
//     });
//   }
// );

let fullReply = "";

fullReply = await aiResponse(
  messages,
  settings.aiModel || "gpt-4o-mini",
  settings.temperature ?? 0.3,
  60
);

// 🔥 NOW SPEAK FULL RESPONSE
await speakText(fullReply, state, twilioWs, {
  transcriberLanguage: state.transcriberLanguage,
  languageCode: state.transcriberLanguage,
  sarvamVoice: state.sarvamVoice,
  elevenLabsVoiceId: settings.elevenLabsVoiceId,
});
        botReply = (botReply || "").trim();
        if (!botReply || botReply.length < 5) {
          botReply = "I understand you'd like to speak with someone. Let me first see if I can help you directly — what seems to be the issue?";
        }
      } catch (err) {
        console.error("[LLM error]", err.message);
        botReply = "I understand you'd like to speak with someone. Let me first see if I can help you directly — what seems to be the issue?";
      }

      //   speakText(botReply, state, twilioWs, {
      //   transcriberLanguage: state.transcriberLanguage,
      //   languageCode: state.transcriberLanguage,
      //   sarvamVoice: state.sarvamVoice,
      //   voice: state.sarvamVoice,
      //   elevenLabsVoiceId: settings.elevenLabsVoiceId,
      //   elevenLabsSpeed: settings.elevenLabsSpeed,
      //   elevenLabsStability: settings.elevenLabsStability,
      //   elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
      //   pace: 1.15
      // });

      // Save to conversation history
      if (!state.interrupted) {
        conversation.push(
          { role: "user", content: cleaned, ts: Date.now() },
          { role: "assistant", content: botReply, ts: Date.now() }
        );
        if (conversation.length > 12) conversation.splice(0, conversation.length - 10);
        sessions.set(callSid, conversation);
      }

      return; // ← DO NOT transfer yet
    }

    // ============================================================
    // SECOND TIME (or more) — Now actually transfer to human
    // ============================================================
    console.log("🔁 Second escalation — transferring to human now");

    const agent = await findAvailableAgent(settings.agentId);

    if (agent) {
      console.log(`📞 Agent found: ${agent.name} (${agent.phone_number})`);

      await speakText(
        "I understand. Let me connect you to one of our team members right now. Please hold.",
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice,
          voice: state.sarvamVoice,
          elevenLabsVoiceId: settings.elevenLabsVoiceId,
          elevenLabsSpeed: settings.elevenLabsSpeed,
          elevenLabsStability: settings.elevenLabsStability,
          elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
          pace: 1.15
        }
      );

      state.transferTo = agent.phone_number;
      state.transferFrom = settings.twilioPhoneNumber;

      const silenceInterval = setInterval(() => {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: state.streamSid,
            media: {
              payload: Buffer.alloc(160, 0xff).toString("base64")
            }
          }));
        }
      }, 20);

      const transferred = await transferCall(
        callSid,
        agent.phone_number,
        settings.twilioAccountSid,
        settings.twilioAuthToken,
        settings.twilioPhoneNumber,
        settings.isInbound || false
      );

      if (!transferred) {
        clearInterval(silenceInterval);
        console.log("⚠️ Transfer failed → falling back to email");
        state.awaitingEscalationEmail = true;
        await speakText(
          "I'm sorry, I couldn't connect you right now. Could you please provide your email and we will call you back?",
          state,
          twilioWs,
          {
            transcriberLanguage: state.transcriberLanguage,
            languageCode: state.transcriberLanguage,
            sarvamVoice: state.sarvamVoice,
            pace: 1.15
          }
        );
        return;
      }

      await markAgentBusy(agent.id, callSid);

      db.query(`
        INSERT INTO call_routing_logs
          (call_sid, routing_agent_id, agent_phone, status, escalation_email)
        VALUES ($1, $2, $3, 'initiated', $4)
      `, [callSid, agent.id, agent.phone_number, state.pendingEmail || null])
      .catch(err => console.error("❌ routing log error:", err.message));

      clearInterval(silenceInterval);

      console.log("✅ Transfer successful — AI exiting");
      state.callEnding = true;
      state.botSpeaking = false;
      state.interrupted = true;
      state.workflowEngine = null;
      state.currentNode = null;

      setTimeout(() => {
        try {
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
        } catch (e) {}
      }, 2000);

    } else {
      // No agent available → collect email
      console.log("⚠️ No agents available → collecting email");
      state.awaitingEscalationEmail = true;
      await speakText(
        "All our agents are busy right now. Could you please provide your email address and we will call you back shortly?",
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice,
          voice: state.sarvamVoice,
          elevenLabsVoiceId: settings.elevenLabsVoiceId,
          elevenLabsSpeed: settings.elevenLabsSpeed,
          elevenLabsStability: settings.elevenLabsStability,
          elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
          pace: 1.15
        }
      );
    }

    return;
  }
  // ============================================================================
  // 🔁 WORKFLOW ENGINE
  // ============================================================================

  if (intent === "meeting" && !state.awaitingMeetingEmail && !state.meetingEmail) {

  console.log("📅 Meeting intent detected");
  state.awaitingMeetingEmail = true;

  await speakText(
    "Sure. Could you please tell me your email address to schedule the meeting?",
    state,
    twilioWs,
    {
      transcriberLanguage: state.transcriberLanguage,
      languageCode: state.transcriberLanguage,
      sarvamVoice: state.sarvamVoice,
      voice: state.sarvamVoice,
      elevenLabsVoiceId: settings.elevenLabsVoiceId,
      elevenLabsSpeed: settings.elevenLabsSpeed,
      elevenLabsStability: settings.elevenLabsStability,
      elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
      pace: 1.15
    }
  );
  return;
}

// ============================================================================
// 📅 MEETING — STEP 2: Collect email
// ============================================================================

if (state.awaitingMeetingEmail) {

  let emailInput = cleaned;

  try {
    const translitRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `You are a phonetic transliterator. The user is spelling out an email address aloud in Kannada/Hindi/Tamil/Telugu phonetics. Convert ALL words to their English phonetic equivalents.

NUMBER words → digits:
- ವನ್/ಒನ್/one = 1, ಟೂ/two = 2, ತ್ರೀ/three = 3, ಫೋರ್/four = 4
- ಫೈ/five = 5, ಸಿಕ್ಸ್/six = 6, ಸೆವೆನ್/seven = 7
- ಎಯ್ಟ್/eight = 8, ನೈನ್/nine = 9, ಝೀರೋ/zero = 0

@ words → "at": ಆಟ್/ಎಟ್/at the rate = at
DOT words → "dot": ಡಾಟ್/ನೌಟ್/ಡೌಟ್/point = dot
COM words → "com": ಕೊಂ/ಕೋವ್/ಕಾಮ್ = com
GMAIL words → "gmail": ಜಿಮೇಲ್/ಎಂಜಿ ಮೈಲ್/G mail = gmail

LETTER spellings → single letter:
- ಎ=a, ಬಿ=b, ಸಿ=c, ಡಿ=d, ಇ=e, ಎಫ್=f, ಜಿ=g, ಎಚ್=h, ಐ=i
- ಜೆ=j, ಕೆ=k, ಎಲ್=l, ಎಂ=m, ಎನ್=n, ಓ=o, ಪಿ=p, ಕ್ಯೂ=q
- ಆರ್=r, ಎಸ್=s, ಟಿ=t, ಯೂ=u, ವಿ=v, ಡಬ್ಲ್ಯೂ=w, ಎಕ್ಸ್=x, ವೈ=y, ಝೆಡ್=z

RULES: Ignore filler words. Return ONLY the transliterated English version.`
        },
        { role: "user", content: cleaned }
      ]
    });

    const transliterated = translitRes.choices[0].message.content.trim().toLowerCase();
    console.log(`🔤 Transliterated: "${cleaned}" → "${transliterated}"`);

    const extractRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content: `Extract and return ONLY the email address from this English text.
Rules:
- "at" or "@" = @
- "dot" or "." = .
- consecutive letters/numbers = join them
- Return ONLY the email like: name@domain.com
- If no valid email, return: NONE`
        },
        { role: "user", content: transliterated }
      ]
    });

    emailInput = extractRes.choices[0].message.content.trim().toLowerCase();
    console.log(`📧 Meeting email extracted: "${cleaned}" → "${emailInput}"`);

  } catch (err) {
    console.error("Meeting email parse error:", err.message);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  if (emailInput !== "none" && emailRegex.test(emailInput)) {

    state.meetingEmail = emailInput;
    state.awaitingMeetingEmail = false;
    state.awaitingMeetingPhone = true;

    await speakText(
      "Thank you. Could you also tell me your phone number?",
      state,
      twilioWs,
      {
        transcriberLanguage: state.transcriberLanguage,
        languageCode: state.transcriberLanguage,
        sarvamVoice: state.sarvamVoice,
        voice: state.sarvamVoice,
        elevenLabsVoiceId: settings.elevenLabsVoiceId,
        elevenLabsSpeed: settings.elevenLabsSpeed,
        elevenLabsStability: settings.elevenLabsStability,
        elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
        pace: 1.15
      }
    );

  } else {

    await speakText(
      "I couldn't detect a valid email address. Please repeat your email.",
      state,
      twilioWs,
      {
        transcriberLanguage: state.transcriberLanguage,
        languageCode: state.transcriberLanguage,
        sarvamVoice: state.sarvamVoice,
        voice: state.sarvamVoice,
        elevenLabsVoiceId: settings.elevenLabsVoiceId,
        elevenLabsSpeed: settings.elevenLabsSpeed,
        elevenLabsStability: settings.elevenLabsStability,
        elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
        pace: 1.15
      }
    );
  }

  return;
}

// ============================================================================
// 📅 MEETING — STEP 3: Collect phone number
// ============================================================================

if (state.awaitingMeetingPhone) {

  let phoneInput = cleaned;

  try {
    const translation = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 20,
      messages: [
        {
          role: "system",
          content: `Convert the spoken phone number to digits only.
The input may be in any Indian language (Kannada, Hindi, Tamil, Telugu, etc.) or English.

DIGIT MAPPINGS (all languages):
0: zero/ಸೊನ್ನೆ/shunya/సున్న/சுழியம്/പൂജ്യം/শূন্য
1: one/ek/ಒಂದು/ఒకటి/ஒன்று/ഒന്ന്/এক
2: two/do/ಎರಡು/రెండు/இரண்டு/രണ്ട്/দুই
3: three/teen/ಮೂರು/మూడు/மூன்று/മൂന്ന്/তিন
4: four/char/ನಾಲ್ಕು/నాలుగు/நான்கு/നാല്/চার
5: five/paanch/ಐದು/అయిదు/ஐந்து/അഞ്ച്/পাঁচ
6: six/chhe/ಆರು/ఆరు/ஆறு/ആറ്/ছয়
7: seven/saat/ಏಳು/ಸೆವೆನ್/ఏడు/ஏழு/ഏഴ്/সাত
8: eight/aath/ಎಂಟು/ಐಟ್/ಎಟ್/ఎనిమిది/எட்டு/എട്ട്/আট
9: nine/nau/ಒಂಬತ್ತು/ನೈನ್/ನ್ಯಾಯ/తొమ్మిది/ஒன்பது/ഒമ്പത്/নয়

KANNADA NUMERALS: ೦=0 ೧=1 ೨=2 ೩=3 ೪=4 ೫=5 ೬=6 ೭=7 ೮=8 ೯=9
HINDI NUMERALS:   ०=0 १=1 २=2 ३=3 ४=4 ५=5 ६=6 ७=7 ८=8 ९=9

PATTERNS:
- "double X" / "ಡಬಲ್ X" = XX
- "triple X" / "ತ್ರಿಪಲ್ X" / "ಟ್ರಿಬಲ್ X" = XXX

Return ONLY digits. No spaces, no dashes, nothing else.`
        },
        { role: "user", content: cleaned }
      ]
    });

    phoneInput = translation.choices[0].message.content.trim();
    console.log(`📱 Phone parsed: "${cleaned}" → "${phoneInput}"`);

  } catch (err) {
    console.error("Phone parse error:", err.message);
  }

  const phone = phoneInput.replace(/\D/g, "");

  // Accumulate digits across partial transcripts
  if (phone.length > (state.phoneBuffer?.length || 0)) {
    state.phoneBuffer = phone;
  } else {
    state.phoneBuffer = (state.phoneBuffer || "") + phone;
  }

  console.log(`📱 Phone buffer: "${state.phoneBuffer}" (${state.phoneBuffer.length} digits)`);

  if (state.phoneBuffer.length >= 10) {
    const callSid = streamToCallMap.get(state.streamSid);
    const finalPhone = state.phoneBuffer.slice(0, 10);
    state.meetingPhone = finalPhone;
    state.awaitingMeetingPhone = false;
    state.phoneBuffer = null;
    state.phoneAttempts = 0;

        try {
        await db.query(
          `INSERT INTO meeting_requests (call_sid, email, phone)
           VALUES ($1, $2, $3)`,
          [callSid, state.meetingEmail, state.meetingPhone]
        );
    
        console.log("💾 Meeting saved:", {
          email: state.meetingEmail,
          phone: state.meetingPhone
        });
    
      } catch (err) {
        console.error("❌ DB insert error:", err.message);
      }

    console.log("📅 Meeting details collected:", {
      email: state.meetingEmail,
      phone: state.meetingPhone
    });

    const readableNumber = finalPhone.split("").join(" ");

    await speakText(
      `Thank you. I've noted your number as ${readableNumber}. Our team will contact you soon. Is there anything else I can help you with?`,
      state,
      twilioWs,
      {
        transcriberLanguage: state.transcriberLanguage,
        languageCode: state.transcriberLanguage,
        sarvamVoice: state.sarvamVoice,
        voice: state.sarvamVoice,
        elevenLabsVoiceId: settings.elevenLabsVoiceId,
        elevenLabsSpeed: settings.elevenLabsSpeed,
        elevenLabsStability: settings.elevenLabsStability,
        elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
        pace: 1.15
      }
    );

    state.meetingEmail = null;
    state.meetingPhone = null;

  } else if (state.phoneBuffer.length > 0 && state.phoneBuffer.length < 10) {

    console.log(`⏳ Only ${state.phoneBuffer.length} digits so far, waiting...`);
    state.phoneAttempts = (state.phoneAttempts || 0) + 1;

    if (state.phoneAttempts >= 3) {
      state.phoneBuffer = null;
      state.phoneAttempts = 0;

      await speakText(
        "I'm having trouble getting your full number. Could you say all 10 digits slowly, one by one?",
        state,
        twilioWs,
        {
          transcriberLanguage: state.transcriberLanguage,
          languageCode: state.transcriberLanguage,
          sarvamVoice: state.sarvamVoice,
          voice: state.sarvamVoice,
          elevenLabsVoiceId: settings.elevenLabsVoiceId,
          elevenLabsSpeed: settings.elevenLabsSpeed,
          elevenLabsStability: settings.elevenLabsStability,
          elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
          pace: 1.15
        }
      );
    }

  } else {

    await speakText(
      "I couldn't detect a valid phone number. Please say your 10 digit number slowly.",
      state,
      twilioWs,
      {
        transcriberLanguage: state.transcriberLanguage,
        languageCode: state.transcriberLanguage,
        sarvamVoice: state.sarvamVoice,
        voice: state.sarvamVoice,
        elevenLabsVoiceId: settings.elevenLabsVoiceId,
        elevenLabsSpeed: settings.elevenLabsSpeed,
        elevenLabsStability: settings.elevenLabsStability,
        elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
        pace: 1.15
      }
    );
  }

  return;
}

  if (state.workflowEngine) {
    
    const engine = state.workflowEngine;
    if (!state.currentNode) return;

    console.log("➡️ Current node:", state.currentNode.name);

    let nextNode = null;

    if (state.currentNode.type === "conversation") {
      const directEdge = engine.edges.find(
        e =>
          e.from_node_id === state.currentNode.id &&
          e.condition?.type === "direct"
      );
      if (directEdge) {
        nextNode = engine.getNodeById(directEdge.to_node_id);
        console.log("➡️ Moving to next node:", nextNode?.name);
      }
    }

    if (nextNode?.type === "decision") {
      nextNode = await engine.aiSelectNextNode(nextNode.id, userText, state);
    }

    if (!nextNode) {
      console.log("⚠️ No next node resolved");
      return;
    }

    state.currentNode = nextNode;
     state.callSid = callSid;
state.sessions = sessions;

    await engine.executeNode(
      nextNode,
      state,
      twilioWs,
      speakText,
      null,
      userText
    );
    return;
  }

  // ============================================================================
  // 💬 NORMAL AI CONVERSATION
  // ============================================================================

  console.log("👂 USER UTTERANCE", {
    callSid,
    streamSid,
    text: cleaned.slice(0, 500),
    ts: new Date().toISOString(),
  });

  const conversation = sessions.get(callSid) || [];

  // let relevantChunks = [];
  // if (settings.knowledgeChunks && settings.knowledgeChunks.length > 0) {
  //   relevantChunks = await getRelevantChunks(cleaned, settings.agentId, settings.knowledgeChunks, 2);
  // }

  let kbContext = "";
  if (relevantChunks.length > 0) {
    kbContext = relevantChunks.map(chunk => chunk.content).join('\n\n');
  }
console.log(`📚 [KB CONTEXT] Length: ${kbContext.length} chars | Chunks used: ${relevantChunks.length}`);
  const agentPrompt = settings.agentPrompt || settings.systemPrompt || "";

  const systemPrompt = `${agentPrompt}

${kbContext ? `KNOWLEDGE BASE (use this to answer the user's question — prioritize this over general knowledge):\n${kbContext}\n` : ''}

IMPORTANT RULES:
- If the answer is in the KNOWLEDGE BASE above, use it directly to answer. Do NOT say "I don't have information".
- Only say you don't know if the topic is completely absent from the knowledge base.
- Keep responses under 50 words. Be conversational and quick.`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversation.slice(-6),
    { role: "user", content: cleaned }
  ];

  if (state.introduced) {
    messages.unshift({
      role: "system",
      content: "You have already introduced yourself. Do NOT introduce yourself again unless asked who you are."
    });
  }

  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
    state.botSpeaking = false;
    return;
  }



const ttsOpts = {
    transcriberLanguage: settings.transcriberLanguage,
    languageCode: settings.transcriberLanguage,
    sarvamVoice: settings.sarvamVoice,
    voice: settings.sarvamVoice,
    elevenLabsVoiceId: settings.elevenLabsVoiceId,
    elevenLabsSpeed: settings.elevenLabsSpeed,
    elevenLabsStability: settings.elevenLabsStability,
    elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
    pace: 1.15,
  };

//   let fullBotReply = "";

// try {
//   const stream = await openai.chat.completions.create({
//     model: settings.aiModel || "gpt-4o-mini",
//     temperature: settings.temperature ?? 0.7,
//     max_tokens: 100,
//     messages,
//     stream: true,
//   });

//   for await (const chunk of stream) {
//     if (state.interrupted || state.callEnded) break;

//     const token = chunk.choices?.[0]?.delta?.content ?? "";
//     if (!token) continue;

//     const clean = token
//       .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
//       .replace(/[*_~`>#]/g, "")
//       .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

//     fullBotReply += clean;
//   }

// } catch (err) {
//   console.error("[LLM stream error]", err.message);
//   fullBotReply = "Sorry, could you repeat that?";
// }

// if (state.interrupted) {
//   state.interrupted = false;
//   return;
// }

// fullBotReply = fullBotReply.trim();
// if (!fullBotReply || fullBotReply.length < 5) {
//   fullBotReply = "Could you say more about that?";
// }

// state.lastUserActivity = Date.now();

// console.log("🤖 AI RESPONSE", {
//   callSid,
//   streamSid,
//   text: fullBotReply.slice(0, 500),
//   ts: new Date().toISOString(),
// });

// await speakText(fullBotReply, state, twilioWs, ttsOpts);

// REPLACE WITH:
// REPLACE WITH:
let fullBotReply = "";

try {
  const stream = await openai.chat.completions.create({
    model: settings.aiModel || "gpt-4o-mini",
    temperature: settings.temperature ?? 0.7,
    max_tokens: 100,
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    if (state.interrupted || state.callEnded) break;

    const token = chunk.choices?.[0]?.delta?.content ?? "";
    if (!token) continue;

    const clean = token
      .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
      .replace(/[*_~`>#]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    fullBotReply += clean;
  }

} catch (err) {
  console.error("[LLM stream error]", err.message);
  fullBotReply = "Sorry, could you repeat that?";
}

if (state.interrupted) {
  state.interrupted = false;
  return;
}

fullBotReply = fullBotReply.trim();
if (!fullBotReply || fullBotReply.length < 5) {
  fullBotReply = "Could you say more about that?";
}

state.lastUserActivity = Date.now();

console.log("🤖 AI RESPONSE", {
  callSid,
  streamSid,
  text: fullBotReply.slice(0, 500),
  ts: new Date().toISOString(),
});

// ✅ ONE single TTS call — no splits, no glitches
await speakText(fullBotReply, state, twilioWs, ttsOpts);
if (!state.interrupted) {
  conversation.push(
    { role: "user", content: cleaned, ts: Date.now() },
    { role: "assistant", content: fullBotReply, ts: Date.now() }
  );

  if (conversation.length > 12) {
    conversation.splice(0, conversation.length - 10);
  }

  sessions.set(callSid, conversation);
}

state.lastBotSpeechEnd = Date.now();
}

// =============================================================================
// 📞 CALL ROUTING FUNCTIONS
// =============================================================================

async function findAvailableAgent(agentId) {
  try {
    const result = await db.query(`
     SELECT *
FROM routing_agents
WHERE agent_id = $1
AND is_available = true
AND is_active = true
ORDER BY
CASE priority
  WHEN 'HIGH' THEN 1
  WHEN 'MEDIUM' THEN 2
  WHEN 'LOW' THEN 3
END
LIMIT 1
    `, [agentId]);

    return result.rows[0] || null;
  } catch (err) {
    console.error("❌ findAvailableAgent error:", err.message);
    return null;
  }
}

async function transferCall(callSid, toNumber, accountSid, authToken, fromNumber, isInbound = false) {
  try {
    const client = Twilio(accountSid, authToken);

    if (isInbound) {
      // ✅ Inbound call — redirect works fine
      const transferUrl = `https://${process.env.NGROK_URL}/twiml?transferTo=${encodeURIComponent(toNumber)}&transferFrom=${encodeURIComponent(fromNumber)}`;

      console.log(`📞 Inbound redirect to: ${transferUrl}`);

      await client.calls(callSid).update({
        url: transferUrl,
        method: "GET"
      });

    } else {
      // ✅ Outbound call — must conference both legs together
      console.log(`📞 Outbound transfer via conference for: ${toNumber}`);

      const conferenceName = `transfer_${callSid}`;

      // Step 1: Move customer into a conference room
      const customerUrl = `https://${process.env.NGROK_URL}/twiml-conference?room=${encodeURIComponent(conferenceName)}`;

      await client.calls(callSid).update({
        url: customerUrl,
        method: "GET"
      });

      // Step 2: Dial agent into same conference room
      await client.calls.create({
        to: toNumber,
        from: fromNumber,
        url: `https://${process.env.NGROK_URL}/twiml-conference?room=${encodeURIComponent(conferenceName)}`,
        method: "GET",
        statusCallback: `https://${process.env.NGROK_URL}/call-status-callback`,
        statusCallbackEvent: ["completed", "busy", "failed", "no-answer"],
        statusCallbackMethod: "POST"
      });
    }

    console.log(`✅ Call ${callSid} transferred to ${toNumber}`);
    return true;
  } catch (err) {
    console.error("❌ transferCall error:", err.message);
    return false;
  }
}

async function markAgentBusy(agentId, callSid) {
  try {
    await db.query(`
      UPDATE routing_agents
      SET is_available = false,
          current_call_sid = $1
      WHERE id = $2
    `, [callSid, agentId]);

    console.log(`🔴 Agent ${agentId} marked busy`);
  } catch (err) {
    console.error("❌ markAgentBusy error:", err.message);
  }
}

// async function markAgentFree(callSid) {
//   try {
//     await db.query(`
//       UPDATE routing_agents
//       SET is_available = true,
//           current_call_sid = null
//       WHERE current_call_sid = $1
//     `, [callSid]);

//     console.log(`🟢 Agent freed for call: ${callSid}`);
//   } catch (err) {
//     console.error("❌ markAgentFree error:", err.message);
//   }
// }
// =============================================================================
// CALL SETTINGS MANAGEMENT
// =============================================================================
async function markAgentFree(callSid) {
  try {

    let result = await db.query(`
      SELECT routing_agent_id
      FROM call_routing_logs
      WHERE call_sid = $1
      LIMIT 1
    `,[callSid]);

    // If callSid not found → fallback
    if (!result.rows.length) {

      console.log("⚠️ No callSid match → using latest active routing");

      result = await db.query(`
        SELECT routing_agent_id
        FROM call_routing_logs
        WHERE status = 'initiated'
        ORDER BY created_at DESC
        LIMIT 1
      `);

    }

    if (!result.rows.length) {
      console.log("❌ No routing log found");
      return;
    }

    const agentId = result.rows[0].routing_agent_id;

    await db.query(`
      UPDATE routing_agents
      SET is_available = true,
          current_call_sid = NULL
      WHERE id = $1
    `,[agentId]);

    console.log(`🟢 Agent ${agentId} marked available`);

  } catch (err) {
    console.error("❌ markAgentFree error:", err.message);
  }
}
async function saveCallSettings(callSettings, callSid, data) {
  data.createdAt = Date.now();
  callSettings.set(callSid, data);
  console.log(`💾 Settings saved for ${callSid}`);
}

async function getCallSettings(callSettings, streamToCallMap, streamSid) {
  const callSid = streamToCallMap.get(streamSid);
  if (!callSid) return null;
  
  return callSettings.get(callSid) || null;
}

// =============================================================================
// INBOUND CALL SETTINGS LOADER
// =============================================================================

async function loadInboundSettingsByPhone(phoneNumber) {
  try {
    const configResult = await db.query(`
      SELECT * FROM inbound_configs WHERE phone_number = $1
    `, [phoneNumber]);

    if (!configResult.rows.length) return null;

    const config = configResult.rows[0];
    const agentResult = await db.query(`
      SELECT * FROM agents WHERE id::text = $1::text
    `, [config.agent_id]);

    if (!agentResult.rows.length) return null;

    const agent = agentResult.rows[0];

    let firstMessage = "Hello! How can I help you today?";
    if (agent.conversation_config?.agent?.first_message) {
      firstMessage = agent.conversation_config.agent.first_message;
    } else if (config.greeting_message) {
      firstMessage = config.greeting_message;
    }

    let systemPrompt = "You are a helpful AI assistant.";
    if (agent.conversation_config?.agent?.prompt) {
      const promptConfig = agent.conversation_config.agent.prompt;
      if (typeof promptConfig === 'object' && promptConfig.prompt) {
        systemPrompt = promptConfig.prompt;
      } else if (typeof promptConfig === 'string') {
        systemPrompt = promptConfig;
      }
    }

    console.log(`📋 [INBOUND PROMPT] Length: ${systemPrompt.length}`);
console.log(`📋 [INBOUND PROMPT] Preview: "${systemPrompt.slice(0, 150)}"`);

    const [calendarConfig, knowledgeChunks,workflow] = await Promise.all([
      getAgentCalendarConfig(agent.id),
      preFetchAgentKnowledge(agent.id),
      loadWorkflowByAgent(agent.id), 
    ]);
    console.log(`📚 [INBOUND KB] Agent: ${agent.id} | Chunks loaded: ${knowledgeChunks?.length || 0}`);

    // Extract from conversation_config (SINGLE SOURCE OF TRUTH)
const agentLanguage =
  agent.conversation_config?.agent?.language ||
  agent.conversation_config?.asr?.language ||
  "kn";

const agentVoice =
  agent.conversation_config?.tts?.voice_id ||
  "karun";

console.log("🟢 ===== TWILIO INBOUND DEBUG =====");
console.log("Phone:", phoneNumber);
console.log("Agent ID:", agent.id);
console.log("Voice from conversation_config:", agentVoice);
console.log("Language from conversation_config:", agentLanguage);
console.log("===================================");

    return {
      agentId: agent.id,
      agentName: agent.name,
      aiModel: agent.conversation_config?.agent?.prompt?.llm || "gpt-4o-mini",
      temperature: Number(agent.conversation_config?.agent?.prompt?.temperature || 0.7),
      maxTokens: 100,
      systemPrompt: createEnhancedSystemPrompt(systemPrompt, calendarConfig),
      firstMessage: firstMessage,
      calendarConfig,
      knowledgeChunks,
      // sarvamVoice: config.voice || "karun",
      // transcriberLanguage: config.language || "en-IN",
      // transcriberModel: "nova-3",
       sarvamVoice: agentVoice.toLowerCase(),
  transcriberLanguage: agentLanguage,
  transcriberModel: agent.conversation_config?.asr?.model || "nova-3",
      // ElevenLabs settings (if configured)
      elevenLabsVoiceId: agent.conversation_config?.tts?.voice_id || "FGY2WhTYpPnrIDTdsKH5",
  elevenLabsSpeed: parseFloat(agent.conversation_config?.tts?.speed) || 1.2,
  elevenLabsStability: agent.conversation_config?.tts?.stability || 1.0,
  elevenLabsSimilarityBoost: agent.conversation_config?.tts?.similarity_boost || 1.0,
      isInbound: true,
      agentPrompt: systemPrompt,
       twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
      twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
       workflow: workflow || null, 
    };
  } catch (error) {
    console.error("Error loading inbound settings:", error.message);
    throw error;
  }
}

// =============================================================================
// MAIN REGISTRATION FUNCTION
// =============================================================================

 async function loadWorkflowByAgent(agentId) {
  const result = await db.query(
    `SELECT * FROM workflows WHERE agent_id = $1 AND is_active = true`,
    [agentId]
  );

  if (!result.rows.length) return null;

  const workflowId = result.rows[0].id;

  const nodes = await db.query(
    `SELECT * FROM workflow_nodes WHERE workflow_id = $1`,
    [workflowId]
  );

  const edges = await db.query(
    `SELECT * FROM workflow_edges WHERE workflow_id = $1`,
    [workflowId]
  );

  return {
    id: workflowId,
    nodes: nodes.rows,
    edges: edges.rows
  };
}


// async function detectIntent(text) {
//   try {
//     const response = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       max_tokens: 10,
//       messages: [
//         {
//           role: "system",
//           content: `Classify the user's intent.

// Return ONLY one word:

// escalation → user wants human / support / real person
// normal → normal conversation

// Examples:
// "I want to talk to a human" → escalation
// "Connect me to support" → escalation
// "I need help with billing" → normal
// "Tell me about your service" → normal`
//         },
//         {
//           role: "user",
//           content: text
//         }
//       ]
//     });

//     const intent = response.choices[0].message.content.trim().toLowerCase();
//     return intent;

//   } catch (err) {
//     console.error("Intent detection error:", err.message);
//     return "normal";
//   }
// }

// async function detectIntent(text) {
//   try {
//     const response = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       max_tokens: 10,
//       messages: [
//         {
//           role: "system",
//           content: `Classify the user's intent. Be VERY strict.

// Return ONLY one word:

// escalation → user is EXPLICITLY and DIRECTLY asking to speak to a human, agent, or real person RIGHT NOW
// normal → everything else including complaints, questions, problems, billing issues, refunds, frustration

// ESCALATION only if user says things like:
// - "connect me to a human"
// - "I want to talk to a real person"
// - "transfer me to an agent"
// - "let me speak to someone"
// - "connect me to your team"
// - "I want a human agent"
// - "talk to real person"
// - "connect me now"

// NOT escalation (these are normal even if frustrated):
// - "my money didn't come back"
// - "I have a billing issue"
// - "this is not working"
// - "I purchased something"
// - "can you help me"
// - "I'm facing a problem"
// - "refund not received"
// - "are you an AI"
// - any question or complaint without explicitly asking for human

// When in doubt → normal

// Examples:
// "I want to talk to a human" → escalation
// "Connect me to an agent" → escalation
// "Transfer me now" → escalation
// "The money did not came back yet" → normal
// "I have a billing issue. Can I resolve it?" → normal
// "I need help with my account" → normal
// "Can you explain CRM?" → normal
// "Are you an AI?" → normal
// "I'm frustrated with the service" → normal`
//         },
//         {
//           role: "user",
//           content: text
//         }
//       ]
//     });

//     const intent = response.choices[0].message.content.trim().toLowerCase();
//     console.log(`🎯 Intent: "${text.slice(0, 50)}" → ${intent}`);
//     return intent;

//   } catch (err) {
//     console.error("Intent detection error:", err.message);
//     return "normal";
//   }
// }


const intentCache = new Map();

async function detectIntent(text) {
  const cacheKey = text.trim().toLowerCase().slice(0, 80);
  if (intentCache.has(cacheKey)) return intentCache.get(cacheKey);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 10,
      messages: [
        {
          role: "system",
          content: `Classify the user's intent. Be VERY strict.

Return ONLY one word: escalation, meeting, or normal

ESCALATION — user is EXPLICITLY asking to speak to a human/agent/real person RIGHT NOW:
- "connect me to a human"
- "I want to talk to a real person"
- "transfer me to an agent"
- "let me speak to someone"
- "I want a human agent"

MEETING — user wants to schedule/book/arrange something:
- "I want to schedule a meeting"
- "book a demo"
- "can we arrange a call"
- "I want to book an appointment"
- "schedule a discussion"
- "talk to sales"
- "I want a demo"
- Works in ANY language — Hindi, Kannada, Tamil, Telugu, etc.

Kannada meeting examples:
- "ಮೀಟಿಂಗ್ ಶೆಡ್ಯೂಲ್ ಮಾಡಬೇಕು" → meeting
- "ಡೆಮೊ ಬುಕ್ ಮಾಡಬೇಕು" → meeting
- "ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬೇಕು" → meeting

Hindi meeting examples:
- "मुझे मीटिंग शेड्यूल करनी है" → meeting
- "डेमो बुक करना है" → meeting

NORMAL — everything else: questions, complaints, problems, billing, refunds, frustration.

When in doubt → normal

Examples:
"I want to talk to a human" → escalation
"Connect me to an agent" → escalation
"I want to schedule a meeting" → meeting
"Book a demo for me" → meeting
"The money did not come back" → normal
"I have a billing issue" → normal
"Can you explain your service?" → normal
"Are you an AI?" → normal`
        },
        {
          role: "user",
          content: text
        }
      ]
    });
    // const intent = response.choices[0].message.content.trim().toLowerCase();
    // console.log(`🎯 Intent: "${text.slice(0, 50)}" → ${intent}`);
    // return intent;
    const intent = response.choices[0].message.content.trim().toLowerCase();
    console.log(`🎯 Intent: "${text.slice(0, 50)}" → ${intent}`);
    intentCache.set(cacheKey, intent);
    if (intentCache.size > 200) intentCache.clear();
    return intent;

  } catch (err) {
    console.error("Intent detection error:", err.message);
    return "normal";
  }
}



export async function registerTwilio(fastify, deps) {
  const { sessions, callSettings, streamToCallMap } = deps;
 fastify.all("/twiml-conference", async (req, reply) => {
    const room = req.query.room || req.body?.room;

    console.log(`📞 Conference TwiML for room: ${room}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference 
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
      startConferenceOnEnter="true"
      endConferenceOnExit="false"
      beep="false">
      ${room}
    </Conference>
  </Dial>
</Response>`;

    reply.type("text/xml").send(twiml);
  });

 fastify.all("/twiml", async (request, reply) => {
    try {
      const transferTo = request.query.transferTo || request.body?.transferTo;
      const transferFrom = request.query.transferFrom || request.body?.transferFrom;

      const vr = new Twilio.twiml.VoiceResponse();

      if (transferTo) {
        // ✅ This is a transfer — connect to human agent
        console.log(`📞 /twiml serving transfer: ${transferFrom} → ${transferTo}`);
        const dial = vr.dial({ callerId: transferFrom, timeout: 30 });
        dial.number(transferTo);
      } else {
        // Normal call — start WebSocket stream
        vr.say("Hello! Connecting you now.");
        const connect = vr.connect();
        connect.stream({ url: `wss://${DOMAIN}/ws-direct` });
      }

      reply.type("text/xml").send(vr.toString());
    } catch (error) {
      console.error("❌ TwiML error:", error.message);
      reply.type("text/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
        <Response><Say>Internal Error</Say></Response>`
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
      sarvamVoice,
      elevenLabsVoiceId,
      elevenLabsSpeed = 1.2,
      elevenLabsStability = 1.0,
      elevenLabsSimilarityBoost = 1.0,
    } = request.body;

    if (!toNumber || !/^\+\d+$/.test(toNumber)) {
      return reply.code(400).send({ error: "Invalid phone number" });
    }

    try {
      const client = Twilio(twilioAccountSid, twilioAuthToken);

      const [calendarConfig, knowledgeChunks] = await Promise.all([
        getAgentCalendarConfig(agentId),
        preFetchAgentKnowledge(agentId),
      ]);

      const workflow = await loadWorkflowByAgent(agentId);
      console.log("📊 Loaded workflow:", workflow?.id || "none");

      const enhancedSystemPrompt = createEnhancedSystemPrompt(systemPrompt, calendarConfig);

      const call = await client.calls.create({
        to: toNumber,
        from: twilioPhoneNumber,
        url: `https://${DOMAIN}/twiml`,
        record: true,
        recordingChannels: "dual",
      });

      const settingsData = {
        agentId,
        transcriberProvider,
        transcriberLanguage,
        transcriberModel,
        aiModel,
        temperature: parseFloat(temperature),
        systemPrompt: enhancedSystemPrompt,
        agentPrompt: systemPrompt,
        firstMessage,
        maxTokens: 100,
        calendarConfig: calendarConfig || null,
        knowledgeChunks,
        // Sarvam TTS settings
        sarvamVoice,
        // ElevenLabs TTS settings
        elevenLabsVoiceId,
        elevenLabsSpeed,
        elevenLabsStability,
        elevenLabsSimilarityBoost,
        workflow,
        twilioAccountSid,
        twilioAuthToken,
        twilioPhoneNumber,
      };

      await saveCallSettings(callSettings, call.sid, settingsData);
      sessions.set(call.sid, []);

      reply.send({
        success: true,
        callSid: call.sid,
        to: toNumber,
      });
    } catch (err) {
      console.error("❌ Call creation failed:", err.message);
      reply.code(500).send({ error: "Failed to create call" });
    }
  });

  fastify.register(async function (f) {
    f.get("/ws-direct", { websocket: true }, (twilioWs, req) => {
      console.log("\n🔌 Twilio WebSocket connected");

      const state = {
        streamSid: null,
        botSpeaking: false,
        interrupted: false,
        callEnded: false,
        lastUserActivity: Date.now(),
        lastBotSpeechEnd: 0,
        stt: null,
        introduced: false ,
        emailBuffer: "",
        emailBufferTimer: null,
        pendingEmail: null,
        awaitingEmailConfirmation: false,
        escalationAttempts: 0, 
         awaitingMeetingEmail: false,
        awaitingMeetingPhone: false,
        meetingEmail: null,
        meetingPhone: null,
         phoneBuffer: null,
        phoneAttempts: 0,
      };

      const connectDeepgram = async () => {
        const settings = await getCallSettings(callSettings, streamToCallMap, state.streamSid);
        if (!settings) return;

        if (state.stt) state.stt.close();

        state.stt = new DeepgramSTT({
          language: settings.transcriberLanguage,
          model: settings.transcriberModel,
        });

      //   state.stt.onInterruption = (text) => {
      //     if (state.awaitingEscalationEmail) return;
      // if (state.botSpeaking && Date.now() - state.lastBotSpeechEnd > 500) {
      //       console.log(`🛑 Interrupted: "${text.slice(0, 30)}..."`);
      //       state.interrupted = true;
      //       state.botSpeaking = false;
      //       sendClearEvent(twilioWs, state.streamSid);
      //     }
      //   };

        // state.stt.onTranscript = (text) => {
        //   state.lastUserActivity = Date.now();
          
          
        //   if (!state.interrupted) {
        //     processTurn(text, state, twilioWs, callSettings, sessions, streamToCallMap);
        //   } else {
        //     console.log(`📝 Processing interruption: "${text.slice(0, 30)}..."`);
        //     state.interrupted = false;
        //     processTurn(text, state, twilioWs, callSettings, sessions, streamToCallMap);
        //   }
        // };

     

        await state.stt.connect();

           state.stt.onTranscript = (text) => {
  state.lastUserActivity = Date.now();

  // 🔥 Pre-warm TTS socket IMMEDIATELY on transcript
  if (shouldUseSarvam(state.transcriberLanguage)) {
    state._pendingTTSSocket = ttsManager.sarvamTTS.preOpenSocket({
      languageCode: state.transcriberLanguage,
      voice: state.sarvamVoice,
    });
  }

  state.interrupted = false;
  processTurn(text, state, twilioWs, callSettings, sessions, streamToCallMap);
};

        state.stt.onInterruption = (text) => {
  console.log("🛑 INTERRUPT:", text);

  state.interrupted = true;
  state.botSpeaking = false;

  // 🔥 CLEAR AUDIO IMMEDIATELY
  sendClearEvent(twilioWs, state.streamSid);

  // 🔥 ABORT TTS (FAST STOP)
  if (state.ttsAbortController) {
    try {
      state.ttsAbortController.abort();
    } catch (e) {}
    state.ttsAbortController = null;
  }
};
      };

      twilioWs.on("message", async (raw) => {
        try {
          const evt = JSON.parse(raw.toString());

          if (evt.event === "start") {
            state.streamSid = evt.start.streamSid;
            const callSid = evt.start.callSid;

            if (callSid) {
              streamToCallMap.set(state.streamSid, callSid);
              console.log(`✅ Mapped ${state.streamSid} → ${callSid}`);
            }

            await connectDeepgram();
             const settings = await getCallSettings(callSettings, streamToCallMap, state.streamSid);
              state.transcriberLanguage = settings.transcriberLanguage;
              state.sarvamVoice = settings.sarvamVoice;
if (settings?.workflow) {

  const { WorkflowEngine } = await import('../src/twilioWorkFlow.js');

  const engine = new WorkflowEngine(settings.workflow);

  state.workflowEngine = engine;
  state.agentId = settings.agentId;
  state.knowledgeChunks = settings.knowledgeChunks;
  state.aiModel = settings.aiModel || "gpt-4o-mini";
  state.temperature = settings.temperature || 0.5;
  state.openai = openai;   // ✅ ADD THIS
  state.sarvamVoice = settings.sarvamVoice;
state.transcriberLanguage = settings.transcriberLanguage;

state.elevenLabsVoiceId = settings.elevenLabsVoiceId;
state.elevenLabsSpeed = settings.elevenLabsSpeed;
state.elevenLabsStability = settings.elevenLabsStability;
state.elevenLabsSimilarityBoost = settings.elevenLabsSimilarityBoost;

  // Get first node
  const startNode = engine.getStartNode();
  state.currentNode = startNode;

  // Execute first node (Initial Greeting)
  await engine.executeNode(
    startNode,
    state,
    twilioWs,
    speakText,
      null,
  "",
    async () => {
      twilioWs.close();
    }
  );
}
          setTimeout(async () => {
  const settings = await getCallSettings(callSettings, streamToCallMap, state.streamSid);
  if (!settings) return;

  // 🔥 Only speak greeting if NO workflow exists
  if (!settings.workflow) {
    const firstMsg = settings.firstMessage || "Hello! How can I help?";

    await speakText(firstMsg, state, twilioWs, {
      transcriberLanguage: settings.transcriberLanguage,
      languageCode: settings.transcriberLanguage,
      sarvamVoice: settings.sarvamVoice,
      voice: settings.sarvamVoice,
      elevenLabsVoiceId: settings.elevenLabsVoiceId,
      elevenLabsSpeed: settings.elevenLabsSpeed,
      elevenLabsStability: settings.elevenLabsStability,
      elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
      pace: 1.15
    });

    state.introduced = true;
  }
}, 500);
          }

          if (evt.event === "media") {
            if (!state.stt || !state.stt.ready) return;
            const mulawChunk = Buffer.from(evt.media.payload, "base64");
            state.stt.sendAudio(mulawChunk);
          }

          if (evt.event === "stop") {
            console.log("📞 Call ended by Twilio");
            cleanup();
          }
        } catch (e) {
          console.error("WS error:", e.message);
        }
      });

      twilioWs.on("close", () => {
        console.log("📞 WebSocket closed");
        cleanup();
      });

      const idleCheck = setInterval(() => {
        const idleMs = Date.now() - state.lastUserActivity;

        if (state.botSpeaking) {
          state.lastUserActivity = Date.now();
          return;
        }

        if (idleMs > 45000) {
          console.log(`⏱️ Idle timeout (${idleMs/1000|0}s)`);
          state.botSpeaking = true;
          speakText("Thanks for calling! Goodbye.", state, twilioWs)
            .then(() => setTimeout(() => twilioWs.close(), 2000));
          clearInterval(idleCheck);
        }
      }, 5000);

      const cleanup = () => {
        clearInterval(idleCheck);
        if (state.stt) {
          state.stt.close();
          state.stt = null;
        }
        state.callEnded = true;
      };
    });
  });

  fastify.all("/inbound-call", async (req, reply) => {
     console.log("RAW BODY:", req.body);
    const incomingNumber = req.body.To;
    const fromNumber = req.body.From;
    const callSid = req.body.CallSid;

    console.log("📞 Inbound call:", { to: incomingNumber, from: fromNumber });

    try {
      const inboundSettings = await loadInboundSettingsByPhone(incomingNumber);

      if (!inboundSettings) {
        const vr = new Twilio.twiml.VoiceResponse();
        vr.say("Sorry, this number is not configured.");
        return reply.type("text/xml").send(vr.toString());
      }

      await saveCallSettings(callSettings, callSid, {
        ...inboundSettings,
        fromNumber,
        toNumber: incomingNumber,
        isInbound: true
      });
      
      sessions.set(callSid, []);

      const vr = new Twilio.twiml.VoiceResponse();
      const connect = vr.connect();
      connect.stream({ url: `wss://${DOMAIN}/ws-direct` });

      reply.type("text/xml").send(vr.toString());
    } catch (error) {
      console.error("❌ Inbound call error:", error.message);
      const vr = new Twilio.twiml.VoiceResponse();
      vr.say("Configuration error. Please try later.");
      reply.type("text/xml").send(vr.toString());
    }
  });

  fastify.post("/end-call/:callSid", async (request, reply) => {
    const { callSid } = request.params;
    const settings = callSettings.get(callSid);
    
    if (!settings) {
      return reply.code(404).send({ error: "Call not found" });
    }
    
    try {
      const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
      await client.calls(callSid).update({ status: 'completed' });
      
      callSettings.delete(callSid);
      sessions.delete(callSid);
      
      reply.send({ success: true, message: "Call ended" });
    } catch (err) {
      console.error("❌ End call failed:", err.message);
      reply.code(500).send({ error: "Failed to end call" });
    }
  });

  // ============================================================================
  // 📡 CALL STATUS CALLBACK — Auto-free agent when call ends
  // ============================================================================

  // ============================================================================
  // 📞 TRANSFER TWIML — Called by Twilio to bridge call to agent
  // ============================================================================

  fastify.all("/transfer-twiml", async (req, reply) => {
    const toNumber = req.query.to || req.body.to;
    const fromNumber = req.query.from || req.body.from;

    console.log(`📞 Transfer TwiML: ${fromNumber} → ${toNumber}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${fromNumber}" timeout="30" timeLimit="3600">
    <Number>${toNumber}</Number>
  </Dial>
</Response>`;

    reply.type("text/xml").send(twiml);
  });

  fastify.post("/call-status-callback", async (req, reply) => {
    try {
      const { CallSid, CallStatus } = req.body;

      console.log(`📞 Call status callback: ${CallSid} → ${CallStatus}`);

      if (["completed", "failed", "busy", "no-answer", "canceled"].includes(CallStatus)) {

        // Free the agent who was on this call
        await markAgentFree(CallSid);

        // Update routing log
        await db.query(`
          UPDATE call_routing_logs
          SET status = $1,
              ended_at = NOW()
          WHERE call_sid = $2
        `, [CallStatus, CallSid]);

        console.log(`✅ Agent freed and log updated for: ${CallSid}`);
      }

      reply.send({ ok: true });

    } catch (err) {
      console.error("❌ call-status-callback error:", err.message);
      reply.send({ ok: false });
    }
  });

  fastify.post("/debug/inbound-lookup", async (req, reply) => {
    const { phoneNumber } = req.body;
    const result = await db.query(
      "SELECT phone_number, agent_id FROM inbound_configs WHERE phone_number = $1",
      [phoneNumber]
    );
    reply.send({ found: result.rows.length > 0, rows: result.rows });
  });
}