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

function isIndianLanguage(languageCode) {
  if (!languageCode) return false;
  const normalized = languageCode.toLowerCase();
  return normalized in INDIAN_LANGUAGES;
}

function normalizeLanguageCode(languageCode) {
  if (!languageCode) return null;
  const normalized = languageCode.toLowerCase();
  return INDIAN_LANGUAGES[normalized] || null;
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

// =============================================================================
// ELEVENLABS TTS (GLOBAL LANGUAGES)
// =============================================================================

class ElevenLabsTTS {
  constructor(apiKey) {
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing");
    this.apiKey = apiKey;
    this.baseUrl = "https://api.elevenlabs.io/v1";
  }

  async generateAndStream(text, options = {}, twilioWs, state) {
    if (!text?.trim() || state.interrupted || state.callEnded) return 0;

    const voiceId = options.voiceId || "pNInz6obpgDQGcFmaJgB";
    const speed = options.speed ?? 1.2;
    const stability = options.stability ?? 1.0;
    const similarityBoost = options.similarityBoost ?? 1.0;

    try {
      console.log(`✅ ElevenLabs Config: voice=${voiceId}, speed=${speed}`);

      const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: stability,
            similarity_boost: similarityBoost,
            speed: speed
          }
        })
      });

      // if (!response.ok) {
      //   throw new Error(`ElevenLabs API error: ${response.status}`);
      // }
      if (!response.ok) {
  let rawBody = "";
  let jsonBody = null;

  try {
    rawBody = await response.text();
    try {
      jsonBody = JSON.parse(rawBody);
    } catch (_) {}
  } catch (_) {}

  console.error("❌ ElevenLabs API ERROR (FULL DUMP)");
  console.error("Status:", response.status);
  console.error("Status Text:", response.statusText);
  console.error("URL:", response.url);
  console.error("Headers:", Object.fromEntries(response.headers.entries()));
  console.error("Raw Body:", rawBody);
  if (jsonBody) console.error("Parsed JSON:", jsonBody);

  // IMPORTANT: throw AFTER logging
  throw new Error(`ElevenLabs API error ${response.status}`);
}


      const reader = response.body.getReader();
      let totalBytes = 0;
      let audioBuffer = Buffer.alloc(0);

      while (true) {
        const { done, value } = await reader.read();
        
        if (done || state.interrupted || state.callEnded) break;

        if (value) {
          audioBuffer = Buffer.concat([audioBuffer, Buffer.from(value)]);

          // Process in chunks
          while (audioBuffer.length >= 4096) {
            const chunk = audioBuffer.slice(0, 4096);
            audioBuffer = audioBuffer.slice(4096);

            try {
              const pcm = await mp3Base64ToPcm(chunk.toString('base64'));
              const mulaw = linear16ToMulaw(pcm);

              if (!state.interrupted && !state.callEnded && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({
                  event: "media",
                  streamSid: state.streamSid,
                  media: {
                    track: "outbound",
                    payload: mulaw.toString("base64")
                  }
                }));
                totalBytes += mulaw.length;
              }
            } catch (e) {
              console.error("[ElevenLabs conversion error]", e.message);
            }
          }
        }
      }

      // Process remaining buffer
      if (audioBuffer.length > 0 && !state.interrupted && !state.callEnded) {
        try {
          const pcm = await mp3Base64ToPcm(audioBuffer.toString('base64'));
          const mulaw = linear16ToMulaw(pcm);

          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid: state.streamSid,
              media: {
                track: "outbound",
                payload: mulaw.toString("base64")
              }
            }));
            totalBytes += mulaw.length;
          }
        } catch (e) {
          console.error("[ElevenLabs final chunk error]", e.message);
        }
      }

      return totalBytes;
    } catch (error) {
      // console.error("[ElevenLabs TTS] Error:", error.message);
      // return 0;
       console.error("🔥 [ElevenLabs TTS] Fatal Error");
  console.error("Message:", error.message);
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
    if (isIndianLanguage(languageCode)) {
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
        voiceId: options.elevenLabsVoiceId || "pNInz6obpgDQGcFmaJgB",
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
      endpointing: 200,
      utterance_end_ms: 1000,
    });

    this.socket.on(LiveTranscriptionEvents.Open, () => {
      this.ready = true;
      console.log("✅ Deepgram STT connected");
    });

    this.socket.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript;
      
      if (text && text.trim()) {
        const now = Date.now();
        
        if (!data.speech_final && this.onInterruption) {
          this.onInterruption(text.trim());
        }
        
        if (data.speech_final && this.onTranscript) {
          if (now - this.lastTranscriptTime > 300) {
            this.lastTranscriptTime = now;
            this.onTranscript(text.trim(), true);
          }
        }
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

async function aiResponse(messages, model, temperature, maxTokens) {
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
      const clean = token
        .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
        .replace(/[*_~`>#]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      fullMessage += clean;
    }
    return fullMessage.trim();
  } catch (err) {
    console.error("[aiResponse] error:", err.message);
    return "I apologize, but I'm having trouble processing that. Could you repeat?";
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

async function preFetchAgentKnowledge(agentId) {
  try {
    const queryEmbedding = await embedText("general information about products and services");
    if (!queryEmbedding) return [];

    const results = await index.query({
      vector: queryEmbedding,
      topK: 50,
      includeMetadata: true,
      filter: { agent_id: agentId },
    });

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

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter(c => c.score > 0 || topK === Infinity);
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

  state.interrupted = false;
  state.botSpeaking = true;

  try {
    sendClearEvent(twilioWs, state.streamSid);
    await new Promise(r => setTimeout(r, 50));

    const totalBytes = await ttsManager.generateAndStream(
      text,
      ttsOptions,
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

// =============================================================================
// TURN PROCESSING
// =============================================================================

async function processTurn(userText, state, twilioWs, callSettings, sessions, streamToCallMap) {
  if (!userText?.trim()) return;

  const streamSid = state.streamSid;
  const callSid = streamToCallMap.get(streamSid);
  const settings = callSettings.get(callSid);
  
  if (!settings) {
    console.warn(`[processTurn] No settings for ${streamSid}`);
    return;
  }

  if (state.botSpeaking) {
    await new Promise(r => setTimeout(r, 100));
  }

  const cleaned = userText.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  
  if (cleaned.length < 5 || words.length < 2) return;

  console.log("👂 USER UTTERANCE", {
    callSid,
    streamSid,
    text: cleaned.slice(0, 500),
    ts: new Date().toISOString(),
  });

  const conversation = sessions.get(callSid) || [];

  let relevantChunks = [];
  if (settings.knowledgeChunks && settings.knowledgeChunks.length > 0) {
    relevantChunks = await getRelevantChunks(cleaned, settings.agentId, settings.knowledgeChunks, 2);
  }

  let kbContext = "";
  if (relevantChunks.length > 0) {
    kbContext = relevantChunks.map(chunk => chunk.content).join('\n\n');
  }

  const agentPrompt = settings.agentPrompt || settings.systemPrompt || "";

  const systemPrompt = `${agentPrompt}

${kbContext ? `KNOWLEDGE:\n${kbContext}\n` : ''}

Keep responses under 50 words. Be conversational and quick.`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversation.slice(-6),
    { role: "user", content: cleaned }
  ];

  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
    state.botSpeaking = false;
    return;
  }

  let botReply;
  try {
    botReply = await aiResponse(
      messages,
      settings.aiModel || "gpt-4o-mini",
      settings.temperature ?? 0.7,
      100
    );

    botReply = (botReply || "").trim();
    
    if (!botReply || botReply.length < 5) {
      botReply = "Could you say more about that?";
    }

  } catch (err) {
    console.error("[LLM error]", err.message);
    botReply = "Sorry, could you repeat that?";
  }

  if (state.interrupted) {
    state.interrupted = false;
    return;
  }

  state.lastUserActivity = Date.now();

  console.log("🤖 AI RESPONSE", {
    callSid,
    streamSid,
    text: botReply.slice(0, 500),
    ts: new Date().toISOString(),
  });

  await speakText(botReply, state, twilioWs, {
    // Pass all TTS options
    transcriberLanguage: settings.transcriberLanguage,
    languageCode: settings.transcriberLanguage,
    sarvamVoice: settings.sarvamVoice,
    voice: settings.sarvamVoice,
    elevenLabsVoiceId: settings.elevenLabsVoiceId,
    elevenLabsSpeed: settings.elevenLabsSpeed,
    elevenLabsStability: settings.elevenLabsStability,
    elevenLabsSimilarityBoost: settings.elevenLabsSimilarityBoost,
    pace: 1.15,
  });

  if (!state.interrupted) {
    conversation.push(
      { role: "user", content: cleaned, ts: Date.now() },
      { role: "assistant", content: botReply, ts: Date.now() }
    );

    if (conversation.length > 12) {
      conversation.splice(0, conversation.length - 10);
    }

    sessions.set(callSid, conversation);
  }
  
  state.lastBotSpeechEnd = Date.now();
}

// =============================================================================
// CALL SETTINGS MANAGEMENT
// =============================================================================

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

    const [calendarConfig, knowledgeChunks] = await Promise.all([
      getAgentCalendarConfig(agent.id),
      preFetchAgentKnowledge(agent.id),
    ]);

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
      sarvamVoice: config.voice || "karun",
      transcriberLanguage: config.language || "en-IN",
      transcriberModel: "nova-3",
      // ElevenLabs settings (if configured)
      elevenLabsVoiceId: config.elevenlabs_voice_id || "pNInz6obpgDQGcFmaJgB",
      elevenLabsSpeed: config.elevenlabs_speed || 1.2,
      elevenLabsStability: config.elevenlabs_stability || 1.0,
      elevenLabsSimilarityBoost: config.elevenlabs_similarity_boost || 1.0,
      isInbound: true,
      agentPrompt: systemPrompt
    };
  } catch (error) {
    console.error("Error loading inbound settings:", error.message);
    throw error;
  }
}

// =============================================================================
// MAIN REGISTRATION FUNCTION
// =============================================================================

export async function registerTwilio(fastify, deps) {
  const { sessions, callSettings, streamToCallMap } = deps;

  fastify.all("/twiml", async (request, reply) => {
    try {
      const vr = new Twilio.twiml.VoiceResponse();
      vr.say("Hello! Connecting you now.");
      const connect = vr.connect();
      connect.stream({ url: `wss://${DOMAIN}/ws-direct` });
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
      };

      const connectDeepgram = async () => {
        const settings = await getCallSettings(callSettings, streamToCallMap, state.streamSid);
        if (!settings) return;

        if (state.stt) state.stt.close();

        state.stt = new DeepgramSTT({
          language: settings.transcriberLanguage,
          model: settings.transcriberModel,
        });

        state.stt.onInterruption = (text) => {
          if (state.botSpeaking) {
            console.log(`🛑 Interrupted: "${text.slice(0, 30)}..."`);
            state.interrupted = true;
            state.botSpeaking = false;
            sendClearEvent(twilioWs, state.streamSid);
          }
        };

        state.stt.onTranscript = (text) => {
          state.lastUserActivity = Date.now();
          
          if (!state.interrupted) {
            processTurn(text, state, twilioWs, callSettings, sessions, streamToCallMap);
          } else {
            console.log(`📝 Processing interruption: "${text.slice(0, 30)}..."`);
            state.interrupted = false;
            processTurn(text, state, twilioWs, callSettings, sessions, streamToCallMap);
          }
        };

        await state.stt.connect();
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

            setTimeout(async () => {
              const settings = await getCallSettings(callSettings, streamToCallMap, state.streamSid);
              if (!settings) {
                await speakText("Hello! How can I help?", state, twilioWs);
                return;
              }

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

  fastify.post("/debug/inbound-lookup", async (req, reply) => {
    const { phoneNumber } = req.body;
    const result = await db.query(
      "SELECT phone_number, agent_id FROM inbound_configs WHERE phone_number = $1",
      [phoneNumber]
    );
    reply.send({ found: result.rows.length > 0, rows: result.rows });
  });
}