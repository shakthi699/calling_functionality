import OpenAI from "openai";
import dotenv from "dotenv";
import querystring from "querystring";
import dns from "dns";
import { SarvamAIClient } from "sarvamai";
import { Readable } from "stream";
dns.setDefaultResultOrder("ipv4first");
dotenv.config({ path: ".env.production" });
dotenv.config();
const { Pinecone } = await import("@pinecone-database/pinecone");
import { createClient } from "@deepgram/sdk";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import WebSocket from "ws";
import { Buffer } from "buffer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import db from '../db.js';
ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================================
// 🔥 PRODUCTION CONFIGURATION
// ============================================================================

const CONFIG = {
// Latency optimization
INTERRUPT_THRESHOLD_MS: 100, // Faster interruption detection
SILENCE_INTERVAL_MS: 200, // Reduced from 250ms
TTS_CHUNK_SIZE: 3200,
MAX_AUDIO_QUEUE: 3, // Reduced queue size
    
// Deepgram optimization
DEEPGRAM_ENDPOINTING: 100, // Faster speech finalization
DEEPGRAM_INTERIM_RESULTS: true,
    
// ElevenLabs optimization
ELEVENLABS_CHUNK_SCHEDULE: [40, 50, 60, 70], // Aggressive chunking
// Slightly higher for reliability; still low enough for latency
ELEVENLABS_TIMEOUT_MS: 8000,
    
// OpenAI optimization
OPENAI_STREAMING_WORD_THRESHOLD: 4, // Start TTS after ~4 words
OPENAI_MAX_TOKENS_INTERRUPT: 15,
OPENAI_MAX_TOKENS_NORMAL: 50, // Reduced from 60
    
// Call management
CALL_SETTINGS_CLEANUP_MS: 5 * 60 * 1000,
SESSION_TIMEOUT_MS: 30 * 60 * 1000,
    
// Rate limiting
MAX_CONCURRENT_CALLS: 50,
RATE_LIMIT_WINDOW_MS: 60000,
MAX_REQUESTS_PER_WINDOW: 100,
};

function requireEnv(name, { optional = false } = {}) {
const value = process.env[name];
if (!value && !optional) {
    throw new Error(`Missing required environment variable: ${name}`);
}
return value;
}

// ============================================================================
// 🎯 CORE INITIALIZATION
// ============================================================================

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const DEEPGRAM_API_KEY = requireEnv("DEEPGRAM_API_KEY");
const ELEVENLABS_API_KEY = requireEnv("ELEVENLABS_API_KEY");
const SARVAM_API_KEY = requireEnv("SARVAM_API_KEY");
// const EXOTEL_SID = requireEnv("EXOTEL_SID");
// const EXOTEL_API_KEY = requireEnv("EXOTEL_API_KEY");
// const EXOTEL_API_TOKEN = requireEnv("EXOTEL_API_TOKEN");
// const EXOTEL_PHONE_NUMBER = requireEnv("EXOTEL_PHONE_NUMBER");
const DOMAIN = requireEnv("NGROK_URL");

const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");
const openai = new OpenAI({ 
apiKey: OPENAI_API_KEY,
timeout: 10000, // 10s timeout
maxRetries: 2,
});
const deepgram = createClient(DEEPGRAM_API_KEY);

const PORT = process.env.PORT || 8080;

    // ============================================================================
    // 🗂️ STATE MANAGEMENT
    // ============================================================================

    class StateManager {
    constructor() {
        this.sessions = new Map();
        this.callSettings = new Map();
        this.streamToCallMap = new Map();
        this.embeddingCache = new Map();
        this.rateLimiter = new Map();
        
        // Performance metrics
        this.metrics = {
        totalCalls: 0,
        activeCalls: 0,
        avgLatency: 0,
        errors: 0,
        interruptions: 0,
        };
        
        // Start cleanup intervals
        this.startCleanupTasks();
    }
    
    startCleanupTasks() {
        // Clean old call settings every minute
        setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [callSid, settings] of this.callSettings.entries()) {
            if (now - settings.createdAt > CONFIG.CALL_SETTINGS_CLEANUP_MS) {
            this.callSettings.delete(callSid);
            this.sessions.delete(callSid);
            cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`🧹 Cleaned up ${cleaned} old call settings`);
        }
        }, 60000);
        
        // Clean embedding cache every 5 minutes
        setInterval(() => {
        if (this.embeddingCache.size > 1000) {
            this.embeddingCache.clear();
            console.log(`🧹 Cleared embedding cache`);
        }
        }, 300000);
    }
    
    checkRateLimit(identifier) {
        const now = Date.now();
        const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;
        
        if (!this.rateLimiter.has(identifier)) {
        this.rateLimiter.set(identifier, []);
        }
        
        const requests = this.rateLimiter.get(identifier);
        const recentRequests = requests.filter(time => time > windowStart);
        
        if (recentRequests.length >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
        return false;
        }
        
        recentRequests.push(now);
        this.rateLimiter.set(identifier, recentRequests);
        return true;
    }
    
    getMetrics() {
        return {
        ...this.metrics,
        activeCalls: this.callSettings.size,
        activeSessions: this.sessions.size,
        cacheSize: this.embeddingCache.size,
        };
    }
    }

    const stateManager = new StateManager();

    export async function registerExotel(fastify, deps) {
    const { sessions, callSettings, streamToCallMap } = deps || stateManager;

    // ============================================================================
    // 🎙️ OPTIMIZED TTS MANAGER
    // ============================================================================

    class OptimizedElevenLabsTTS {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.activeConnections = new Map();
        this.metrics = {
        totalRequests: 0,
        avgLatency: 0,
        errors: 0,
        firstByteLatency: [],
        };
    }

    async generateSpeech(text, options = {}, abortSignal = null) {
        const {
        voiceId = "hpp4J3VqNfWAUOO0d1Us",
        model = "eleven_turbo_v2_5",
        stability = 1.0,
        similarityBoost = 0.8,
        speed = 1.0,
        style = 0.0,
        aggressive = true,
        outputFormat = "pcm_16000"
        } = options;

        const startTime = Date.now();
        this.metrics.totalRequests++;

        return new Promise((resolve, reject) => {
        let firstByteTime = null;
        let wsError = false;
        let closedByAbort = false;
        const audioChunks = [];

        // FIX: Use valid chunk schedule format
        const chunkSchedule = aggressive
            ? CONFIG.ELEVENLABS_CHUNK_SCHEDULE
            : [120, 160, 250, 290];

        if (!text || text.trim().length === 0) {
            return reject(new Error("Text cannot be empty"));
        }

        const uri =
            `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
            `?model_id=${model}&output_format=${outputFormat}`;

        const ws = new WebSocket(uri, {
            headers: { "xi-api-key": this.apiKey },
            perMessageDeflate: false,
            maxPayload: 10 * 1024 * 1024,
        });

        // FIX: Increased timeout for more reliability
        const timeout = setTimeout(() => {
            if (!firstByteTime && !wsError) {
            wsError = true;
            ws.close();
            this.metrics.errors++;
            console.error("❌ TTS timeout - no response from ElevenLabs");
            reject(new Error("TTS timeout - no response from ElevenLabs"));
            }
        }, CONFIG.ELEVENLABS_TIMEOUT_MS);

        ws.on("open", () => {
            if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
                closedByAbort = true;
                try { ws.close(); } catch {}
            });
            }

            // FIX: Use correct payload structure for ElevenLabs
            const payload = {
            text: text.trim(),
            voice_settings: {
                stability,
                similarity_boost: similarityBoost,
                style,
                speed,
                use_speaker_boost: false,
            },
            // FIX: Remove or fix generation_config if causing issues
            // generation_config: {
            //   chunk_length_schedule: chunkSchedule,
            // },
            };

            ws.send(JSON.stringify(payload), (err) => {
            if (err) {
                wsError = true;
                return reject(err);
            }
            
            // Send empty text to indicate end of stream
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ text: "" }));
                }
            }, 100);
            });
        });

        ws.on("message", (rawData) => {
            if (wsError) return;

            try {
            const message = JSON.parse(rawData.toString());

            if (message.audio && !firstByteTime) {
                firstByteTime = Date.now() - startTime;
                this.metrics.firstByteLatency.push(firstByteTime);
                
                if (this.metrics.firstByteLatency.length > 100) {
                this.metrics.firstByteLatency.shift();
                }
                
                clearTimeout(timeout); // Clear timeout when we get first byte
            }

            if (message.audio) {
                const chunk = Buffer.from(message.audio, "base64");
                audioChunks.push(chunk);
            }

            if (message.error) {
                wsError = true;
                console.error("❌ ElevenLabs error:", message.error);
                reject(new Error(`ElevenLabs error: ${message.error}`));
            }
            } catch (e) {
            if (!(e instanceof SyntaxError)) {
                console.error("TTS parse error:", e.message);
            }
            }
        });

        ws.on("close", (code, reason) => {
            clearTimeout(timeout);

            if (wsError) return;

            if (closedByAbort || abortSignal?.aborted) {
            return reject(new Error("TTS_ABORTED"));
            }

            if (audioChunks.length === 0) {
            this.metrics.errors++;
            console.error("❌ No audio chunks received from ElevenLabs");
            return reject(new Error("No audio chunks received"));
            }

            const audio = Buffer.concat(audioChunks);
            const totalTime = Date.now() - startTime;

            this.metrics.avgLatency =
            (this.metrics.avgLatency * (this.metrics.totalRequests - 1) + totalTime) /
            this.metrics.totalRequests;

            console.log(`✅ TTS completed: ${totalTime}ms, ${audio.length} bytes`);
            resolve(audio);
        });

        ws.on("error", (err) => {
            clearTimeout(timeout);
            if (!wsError) {
            wsError = true;
            this.metrics.errors++;
            console.error("❌ WebSocket error:", err.message);
            reject(err);
            }
        });
        });
    }

    getMetrics() {
        const avgFirstByte = this.metrics.firstByteLatency.length > 0
        ? this.metrics.firstByteLatency.reduce((a, b) => a + b, 0) / this.metrics.firstByteLatency.length
        : 0;
        
        return {
        ...this.metrics,
        avgFirstByteLatency: Math.round(avgFirstByte),
        };
    }
    }

const ttsManager = new OptimizedElevenLabsTTS(ELEVENLABS_API_KEY);

    // ============================================================================
    // 🎯 OPTIMIZED SARVAM TTS
    // ============================================================================

class OptimizedSarvamTTS {
    constructor(apiKey) {
        this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
        this.model = "bulbul:v2";
        this.activeConnections = new Map();
    }

    async generateAndStream(text, options = {}, exotelWs, state) {
        const socket = await this.client.textToSpeechStreaming.connect({
            model: this.model,
            send_completion_event: true,
        });

        await socket.waitForOpen();

        const voice = (options.voice || "Arya").toLowerCase();
        const pitch = options.pitch ?? 0.0;
        const pace = options.pace ?? 1.0;
        let languageCode = options.languageCode || "kn-IN";

        const configMessage = {
            type: "config",
            data: {
                target_language_code: languageCode,
                speaker: voice,
                pitch: pitch,
                pace: pace,
                output_audio_codec: "mp3",
                speech_sample_rate: 16000,
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

        socket.on("message", async (msg) => {
            if (
                msg.type === "audio" &&
                msg.data?.audio &&
                exotelWs.readyState === WebSocket.OPEN &&
                !state.interrupted
            ) {
                try {
                    const pcm = await mp3Base64ToPcm(msg.data.audio);
                    console.log(`🔊 Sending PCM16 audio: ${pcm.length} bytes`);
                    exotelWs.send(JSON.stringify({
                        event: "media",
                        stream_sid: state.streamSid,
                        media: { payload: pcm.toString("base64") }
                    }));
                } catch (err) {
                    console.error("[PCM Conversion Error]", err.message);
                }
            }

            if (msg.type === "event" && msg.data?.event_type === "final") {
                console.log(`[Sarvam] Final event received`);
                state.sarvamSpeaking = false;
                state.botSpeaking = false;
            }
        });

        socket.on("error", (err) => {
            console.error("[Sarvam Socket Error]", err.message);
            state.sarvamSpeaking = false;
            state.botSpeaking = false;
        });

        socket.on("close", () => {
            console.log(`[Sarvam] Socket closed`);
            state.sarvamSpeaking = false;
            state.botSpeaking = false;
        });

        socket.convert(text.trim());
        socket.flush();
    }
}



const sarvamTTS = new OptimizedSarvamTTS(SARVAM_API_KEY);

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
};

function normalizeLanguageCode(languageCode) {
  if (!languageCode) return null;
  const normalized = languageCode.toLowerCase();
  return INDIAN_LANGUAGES[normalized] || null;
}
    // ============================================================================
    // 🔧 UTILITY FUNCTIONS
    // ============================================================================

    function mp3Base64ToPcm(mp3Base64) {
    const mp3Buffer = Buffer.from(mp3Base64, "base64");
    return new Promise((resolve, reject) => {
        const pcmChunks = [];
        const timeoutId = setTimeout(() => {
            reject(new Error("FFmpeg conversion timeout"));
        }, 5000);
        
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


    async function endCall(state, exotelWs, reason = "normal") {
  try {
    console.log(`📞 Ending call | Reason: ${reason}`);

    state.interrupted = true;
    state.botSpeaking = false;
    state.sarvamSpeaking = false;

    if (state.activeTTSAbort) {
      try { state.activeTTSAbort.abort(); } catch {}
      state.activeTTSAbort = null;
    }

    sendClearEvent(exotelWs, state.streamSid);

    await sleep(1000); // allow last audio to flush

    if (exotelWs.readyState === WebSocket.OPEN) {
      exotelWs.close();
    }

  } catch (err) {
    console.error("❌ endCall error:", err);
  }
}

    function normalizeSarvamLang(lang) {
    if (!lang) return "kn-IN";
    if (lang.includes("-")) return lang;

    const map = {
        kn: "kn-IN", te: "te-IN", ta: "ta-IN", ml: "ml-IN",
        bn: "bn-IN", gu: "gu-IN", mr: "mr-IN", pa: "pa-IN"
    };

    return map[lang] || "kn-IN";
    }

    const SARVAM_LANGS = ["kn", "te", "mr", "gu", "bn", "ml", "pa"];

    function useSarvam(language) {
    const base = language?.split("-")[0];
    return SARVAM_LANGS.includes(base);
    }

    function convert16kHzPCMTo8kHz(pcm16kBuffer) {
    const inputSamples = new Int16Array(
        pcm16kBuffer.buffer,
        pcm16kBuffer.byteOffset,
        pcm16kBuffer.length / 2
    );
    const outputLength = Math.floor(inputSamples.length / 2);
    const outputSamples = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        outputSamples[i] = inputSamples[i * 2];
    }

    return Buffer.from(outputSamples.buffer);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function sendClearEvent(exotelWs, streamSid) {
    if (exotelWs && exotelWs.readyState === 1 && streamSid) {
        try {
        exotelWs.send(JSON.stringify({
            event: "clear",
            stream_sid: streamSid
        }));

        exotelWs.send(JSON.stringify({
            event: "media",
            stream_sid: streamSid,
            media: { payload: "" }
        }));
        } catch (error) {
        console.error("❌ Error sending clear event:", error);
        }
    }
    }

    // ============================================================================
    // 🚀 ULTRA-LOW-LATENCY AI RESPONSE WITH STREAMING TTS
    // ============================================================================

    async function aiResponseWithStreamingTTS(
    messages,
    model,
    temperature,
    maxTokens,
    state,
    exotelWs,
    ttsOptions = {},
    turnController = null,
    turnSeq = null
    ) {
    const streamStart = Date.now();
    const isElevenLabs = Boolean(ttsOptions.voiceId);
    
    const stream = await openai.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        messages,
        stream: true,
    });

    let fullMessage = "";
    let sentenceBuffer = "";
    let ttsStarted = false;
    let firstTokenTime = null;

    for await (const chunk of stream) {
        if (turnController?.aborted) break;
        if (turnSeq !== null && state.turnSeq !== turnSeq) break;
        const token = chunk.choices?.[0]?.delta?.content ?? "";
        if (!token) continue;

        // Track first token latency
        if (!firstTokenTime) {
        firstTokenTime = Date.now() - streamStart;
        console.log(`⚡ First token: ${firstTokenTime}ms`);
        }

        const clean = token
        .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
        .replace(/[*_~`>#]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

        fullMessage += clean;
        sentenceBuffer += clean;

        // For Sarvam / non-ElevenLabs, we can stream sentence-by-sentence.
        if (!isElevenLabs) {
        const words = sentenceBuffer.split(/\s+/).filter(Boolean);
        const wordCount = words.length;

        const trimmed = sentenceBuffer.trim();
        const lastChar = trimmed.slice(-1);
        const isSentenceEnd = /[.!?]/.test(lastChar);

        const shouldSpeakNow =
            wordCount >= CONFIG.OPENAI_STREAMING_WORD_THRESHOLD &&
            (!ttsStarted || isSentenceEnd);

        if (shouldSpeakNow) {
            ttsStarted = true;
            const firstTTSTime = Date.now() - streamStart;
            console.log(
            `🎤 Starting TTS chunk (${wordCount} words, sentenceEnd=${isSentenceEnd}) at ${firstTTSTime}ms`
            );

            const toSpeak = sentenceBuffer.trim();
            sentenceBuffer = "";

            if (toSpeak.length > 0) {
            speakText(toSpeak, state, exotelWs, ttsOptions).catch(err => {
                console.error("Early/streaming TTS error:", err);
            });
            }
        }
        }
    }

    const totalTime = Date.now() - streamStart;
    console.log(`✅ Stream complete: ${totalTime}ms`);

    // Speak remaining content:
    // - ElevenLabs: speak the full message once (more reliable, fewer timeouts)
    // - Others: speak any leftover sentence fragment.
    const remainingText = isElevenLabs
        ? fullMessage.trim()
        : sentenceBuffer.trim();

    if (
        !state.interrupted &&
        !turnController?.aborted &&
        remainingText.length > 0
    ) {
        await speakText(remainingText, state, exotelWs, ttsOptions);
    }

    return fullMessage;
    }

    // ============================================================================
    // 🎯 OPTIMIZED PROCESS TURN (MAIN CONVERSATION LOGIC)
    // ============================================================================

    async function processTurn(userText, state, exotelWs) {
    const turnStart = Date.now();
    
    try {
        // Hard interrupt check
        if (state.botSpeaking) {
        state.interrupted = true;
        state.botSpeaking = false;
        state.sarvamSpeaking = false;
        sendClearEvent(exotelWs, state.streamSid);
        
        if (state.activeTTSAbort) {
            state.activeTTSAbort.abort();
            state.activeTTSAbort = null;
        }
        
        stateManager.metrics.interruptions++;
        }

        const callSid = streamToCallMap.get(state.streamSid) || state.callSid;
        if (!callSid) return;

        const settings = await getCallSettings(state.streamSid, callSid);
        if (!settings) return;

        const cleaned = userText?.trim();
        if (!cleaned) return;
        const lowerText = userText.toLowerCase();

const END_PHRASES = [
  "end the call",
  "end call",
  "hang up",
  "stop",
  "don't call",
  "do not call",
  "disconnect",
  "cut the call",
];

if (END_PHRASES.some(p => lowerText.includes(p))) {
  console.log("📞 User requested to end call");

  await speakText(
    "Okay, I will end the call now. Thank you. Goodbye.",
    state,
    exotelWs,
    { aggressive: true }
  );

  await sleep(2000);

  await endCall(state, exotelWs, "user_requested");

  return;
}
        // Handle short responses intelligently
        const isVeryShort = cleaned.length < 3;
        if (isVeryShort && !/^(hi|hey|yes|no|ok)$/i.test(cleaned)) {
        console.log(`⏭️ Skipping very short: "${cleaned}"`);
        return;
        }

        let conversation = sessions.get(callSid) || [];
        conversation.push({ role: "user", content: cleaned });

        // Build optimized KB context
        const kbContext = settings.knowledgeChunks
        ?.slice(0, 3) // Reduced from 4
        ?.map(c => c.content)
        ?.join("\n\n") || "";

        const basePrompt = settings?.systemPrompt || 
        "You are a professional AI call agent. Be concise, stay on topic, and avoid repeating questions the caller has already answered.";

        // Optimized system prompt
        const systemPrompt = `${basePrompt}

    ${settings?.agentId ? `Agent: ${settings.agentName || settings.agentId}\n` : ""}
        ${kbContext ? `Knowledge:\n${kbContext}\n` : ""}
        Guidelines:
        - Be extremely concise (1-2 sentences max)
        - Speak naturally like a human in a phone call
        - Use the caller's previous messages to stay on topic
        - Do not repeat the same question unless the caller was unclear
        - Ask a short clarifying question instead of guessing when you are unsure
        - No bullet points or lists in speech
       - If you have successfully collected ALL required information (for example: email, meeting time, and confirmation), you MUST end your final sentence with the exact phrase "[END_CALL]".
- Do not explain that you are ending the call.
- The tag must appear exactly as: [END_CALL]
    `.trim();

        const messages = [
        { role: "system", content: systemPrompt },
        ...conversation.slice(-8), // Reduced context window
        ];

        // Determine max tokens based on interruption
        const maxTokens = state.interrupted
        ? CONFIG.OPENAI_MAX_TOKENS_INTERRUPT
        : CONFIG.OPENAI_MAX_TOKENS_NORMAL;

        // 🚀 USE STREAMING TTS FOR INSTANT RESPONSE
        // let reply = await aiResponseWithStreamingTTS(
        // messages,
        // settings.aiModel || "gpt-4o-mini",
        // settings.temperature || 0.7,
        // maxTokens,
        // state,
        // exotelWs,
        // {
        //     voiceId: settings.elevenLabsVoiceId,
        //     stability: settings.elevenLabsStability || 0.7,
        //     similarityBoost: settings.elevenLabsSimilarityBoost || 0.7,
        //     speed: settings.elevenLabsSpeed || 1.0,
        //     aggressive: true,
        //     language: settings.transcriberLanguage,
        //     voice: (settings.sarvamVoice || "arya").toLowerCase(),  // Normalize to lowercase
        // },
        // state.activeTurnAbort || null,
        // state.turnSeq
        // );
        const functions = createAvailableFunctions(settings.calendarConfig);

const response = await openai.chat.completions.create({
    model: settings.aiModel || "gpt-4o-mini",
    temperature: settings.temperature || 0.7,
    messages,
    tools: functions.map(f => ({
        type: "function",
        function: f
    })),
    tool_choice: "auto"
});

const message = response.choices[0].message;

if (message.tool_calls?.length > 0) {
    const toolCall = message.tool_calls[0];
    const functionName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    console.log("🛠️ Function called:", functionName, args);

    if (functionName === "schedule_meeting") {

        // 👉 TODO: Call your real meeting API here
        const result = { success: true }; // Replace with real API

        if (result.success) {
            await speakText(
                "Your meeting has been scheduled successfully. Thank you. Goodbye.",
                state,
                exotelWs,
                { aggressive: true }
            );
            console.log("✅ Meeting scheduled successfully");
            await sleep(2000);
            await endCall(state, exotelWs, "meeting_scheduled");
            return;
        }
    }

    if (functionName === "hangUp") {
        await speakText(
            args.message || "Thank you for your time. Goodbye.",
            state,
            exotelWs,
            { aggressive: true }
        );
       console.log("📞 Ending call | Reason: ai_hangup");
        await sleep(2000);
        await endCall(state, exotelWs, "ai_hangup");

        return;
    }
    
}

const reply = message.content || "";

await speakText(reply, state, exotelWs, {
    voiceId: settings.elevenLabsVoiceId,
    aggressive: true,
    language: settings.transcriberLanguage,
    voice: (settings.sarvamVoice || "arya").toLowerCase(),
});

       if (reply.includes("[END_CALL]")) {
    console.log("📞 AI decided to end the call.");

    const cleanReply = reply.replace("[END_CALL]", "").trim();

    if (cleanReply.length > 0) {
        await speakText(cleanReply, state, exotelWs, {
            voiceId: settings.elevenLabsVoiceId,
            stability: settings.elevenLabsStability || 0.7,
            similarityBoost: settings.elevenLabsSimilarityBoost || 0.7,
            speed: settings.elevenLabsSpeed || 1.0,
            aggressive: true,
            language: settings.transcriberLanguage,
            voice: (settings.sarvamVoice || "arya").toLowerCase(),
        });

        await sleep(2000);
    }

    await endCall(state, exotelWs, "ai_completed");
    return;
}

        conversation.push({ role: "assistant", content: reply });
        sessions.set(callSid, conversation);

        const turnTime = Date.now() - turnStart;
        console.log(`⏱️ Turn completed: ${turnTime}ms`);

        
        // Update metrics
        stateManager.metrics.avgLatency = 
        (stateManager.metrics.avgLatency * 0.9) + (turnTime * 0.1);

    } catch (err) {
    console.error("❌ processTurn error:", err);

    if (err?.status === 429 || err?.message?.includes("rate")) {
        console.log("🚨 OpenAI rate limit detected. Ending call.");

        await speakText(
            "We're experiencing high demand right now. Please try again later. Goodbye.",
            state,
            exotelWs,
            { aggressive: true }
        );

        await sleep(2000);
        exotelWs.close();
        return;
    }

    await speakText(
        "I encountered an issue. Please try again.",
        state,
        exotelWs
    );
} finally {
        state.interrupted = false;
        state.activeTTSAbort = null;
    }
    }

    // ============================================================================
    // 🔊 OPTIMIZED SPEAK TEXT
    // ============================================================================

    async function speakText(text, state, exotelWs, ttsOptions = {}) {
    if (!exotelWs || exotelWs.readyState !== 1) return;
    if (!text || text.trim().length === 0) return;

    // Queue management
    if (state.botSpeaking) {
        state.audioQueue = state.audioQueue || [];
        if (state.audioQueue.length < CONFIG.MAX_AUDIO_QUEUE) {
        state.audioQueue.push({ text, ttsOptions });
        }
        return;
    }

    state.botSpeaking = true;
    state.interrupted = false;
    state.sarvamSpeaking = true;
    // state.lastUserActivity = Date.now(); 

    const speakStart = Date.now();

    try {
        const language = ttsOptions.language || ttsOptions.transcriberLanguage;

        if (useSarvam(language)) {
        console.log(`🗣️ Sarvam TTS: "${text.substring(0, 40)}..." voice="${(ttsOptions.voice || 'arya').toLowerCase()}"`);
        
        await sarvamTTS.generateAndStream(
            text,
            {
            voice: (ttsOptions.voice || "arya").toLowerCase(),  // Normalize to lowercase
            languageCode: normalizeSarvamLang(language),
            pitch: ttsOptions.pitch ?? 0.0,
            pace: ttsOptions.pace || 1.0,  // Use pace not speed, default to 1.0
            },
            exotelWs,
            state
        );

        } else {
        console.log(`🗣️ ElevenLabs TTS: "${text.substring(0, 40)}..."`);
        
        const abortController = new AbortController();
        state.activeTTSAbort = abortController;

        const audio16k = await ttsManager.generateSpeech(text, {
            voiceId: ttsOptions.voiceId,
            outputFormat: "pcm_16000",
            stability: ttsOptions.stability ?? 1.0,
            similarityBoost: ttsOptions.similarityBoost ?? 0.8,
            speed: ttsOptions.speed || 1.0,
            aggressive: true
        }, abortController.signal);

        if (state.interrupted || !state.botSpeaking) {
            console.log("🛑 Interrupted during TTS generation");
            return;
        }

        if (!audio16k || audio16k.length === 0) {
            console.error("❌ Empty TTS audio");
            return;
        }

        const pcm8k = convert16kHzPCMTo8kHz(audio16k);

        // Stream audio with minimal delay
        for (let i = 0; i < pcm8k.length; i += CONFIG.TTS_CHUNK_SIZE) {
            if (state.interrupted || !state.botSpeaking) {
            console.log(`🛑 Interrupted at chunk ${i}/${pcm8k.length}`);
            sendClearEvent(exotelWs, state.streamSid);
            break;
            }

            const chunk = pcm8k.slice(i, i + CONFIG.TTS_CHUNK_SIZE);
            const padded = chunk.length < CONFIG.TTS_CHUNK_SIZE
            ? Buffer.concat([chunk, Buffer.alloc(CONFIG.TTS_CHUNK_SIZE - chunk.length)])
            : chunk;

            exotelWs.send(JSON.stringify({
            event: "media",
            stream_sid: state.streamSid,
            media: { payload: padded.toString("base64") }
            }));

            // Approximate real-time pacing: 3200 bytes at 8kHz 16‑bit ≈ 200ms
            await sleep(200);
        }
        }

        if (!state.interrupted && state.botSpeaking) {
        const speakTime = Date.now() - speakStart;
        console.log(`🔊 Speech completed: ${speakTime}ms`);
        state.fullTranscript.push({
            role: "bot",
            text,
            timestamp: Date.now() - state.sessionStartTime
        });
        }

    } catch (err) {
        const isAborted = err?.message === "TTS_ABORTED" ||
            (err?.message === "No audio chunks received" && (state.interrupted || !state.botSpeaking));
        if (!isAborted) {
            console.error("❌ speakText error:", err.message);
            stateManager.metrics.errors++;
        }
    } finally {
        state.botSpeaking = false;
        state.sarvamSpeaking = false;
        state.activeTTSAbort = null;
        // state.lastUserActivity = Date.now();

        // Process queue
        if (state.audioQueue?.length > 0 && !state.interrupted) {
        const next = state.audioQueue.shift();
        setTimeout(() => {
            speakText(next.text, state, exotelWs, next.ttsOptions);
        }, 50); // Reduced delay
        }

        setTimeout(() => {
        state.interrupted = false;
        }, 30); // Reduced delay
    }
    }

    // ============================================================================
    // 📞 CALL SETTINGS MANAGEMENT
    // ============================================================================

    async function saveCallSettings(callSid, data) {
    data.createdAt = Date.now();
    data.lastAccessed = Date.now();
    callSettings.set(callSid, data);
    console.log(`💾 Saved ${callSid}: agent=${data.agentId}, KB=${data.knowledgeChunks?.length || 0}`);
    }

    async function getCallSettings(streamSid, incomingCallSid) {
    let callSid = streamToCallMap.get(streamSid);
    
    if (callSid) {
        const settings = callSettings.get(callSid);
        if (settings) {
        settings.lastAccessed = Date.now();
        return settings;
        }
    }
    
    if (incomingCallSid && callSettings.has(incomingCallSid)) {
        const settings = callSettings.get(incomingCallSid);
        if (settings && settings.callType === "inbound") {
        streamToCallMap.set(streamSid, incomingCallSid);
        settings.lastAccessed = Date.now();
        return settings;
        }
    }
    
    // Fallback to recent outbound
    let mostRecentSettings = null;
    let mostRecentTime = 0;
    let mostRecentCallSid = null;
    
    for (const [storedCallSid, settings] of callSettings.entries()) {
        if (settings.createdAt && 
            (Date.now() - settings.createdAt) < 30000 &&
            (!settings.callType || settings.callType === "outbound")) {
        if (settings.createdAt > mostRecentTime) {
            mostRecentTime = settings.createdAt;
            mostRecentSettings = settings;
            mostRecentCallSid = storedCallSid;
        }
        }
    }
    
    if (mostRecentSettings) {
        streamToCallMap.set(streamSid, mostRecentCallSid);
        mostRecentSettings.lastAccessed = Date.now();
        return mostRecentSettings;
    }
    
    return null;
    }

    // ============================================================================
    // 🗄️ KNOWLEDGE BASE & CALENDAR (Optimized)
    // ============================================================================

    async function embedText(text) {
    const cacheKey = text.toLowerCase().trim();
    if (stateManager.embeddingCache.has(cacheKey)) {
        return stateManager.embeddingCache.get(cacheKey);
    }
    
    const embed = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
    });
    
    const result = embed.data[0].embedding;
    stateManager.embeddingCache.set(cacheKey, result);
    return result;
    }

    async function preFetchAgentKnowledge(agentId) {
    try {
        const queryEmbedding = await embedText(
        "company information general query"
        );

        const results = await index.query({
        vector: queryEmbedding,
        topK: 3, // Reduced from 5
        includeMetadata: true,
        filter: { agent_id: agentId },
        });

        console.log(`🧠 KB fetched: ${results.matches.length} chunks`);

        return results.matches.map(match => ({
        content: match.metadata.content,
        embedding: match.values
        }));
    } catch (error) {
        console.error("❌ KB prefetch error:", error);
        return [];
    }
    }

    // ============================================================================
    // 📞 EXOTEL API ROUTES
    // ============================================================================

    // fastify.post("/call-exotel", async (request, reply) => {
    // const {
    //     number: toNumber,
    //     elevenLabsVoiceId,
    //     elevenLabsSpeed,
    //     elevenLabsStability,
    //     elevenLabsSimilarityBoost,
    //     sarvamVoice,
    //     transcriberProvider,
    //     transcriberLanguage,
    //     transcriberModel,
    //     aiModel,
    //     temperature,
    //     systemPrompt,
    //     firstMessage,
    //     maxTokens,
    //     agentId,
    // } = request.body;

    // if (!agentId) {
    //     return reply.code(400).send({ error: "agentId is required" });
    // }

    // // Rate limiting
    // if (!stateManager.checkRateLimit(toNumber)) {
    //     return reply.code(429).send({ error: "Rate limit exceeded" });
    // }

    // // Concurrent call limiting
    // if (stateManager.metrics.activeCalls >= CONFIG.MAX_CONCURRENT_CALLS) {
    //     return reply.code(503).send({ error: "Maximum concurrent calls reached" });
    // }

    // if (!toNumber || !/^\+?[1-9]\d{9,14}$/.test(toNumber)) {
    //     return reply.code(400).send({ error: "Invalid phone number" });
    // }

    // try {
    //     const [calendarConfig, knowledgeChunks] = await Promise.all([
    //     getAgentCalendarConfig(agentId),
    //     preFetchAgentKnowledge(agentId),
    //     ]);

    //     const enhancedSystemPrompt = createEnhancedSystemPrompt(systemPrompt, calendarConfig);

    //     let formattedToNumber = toNumber.replace(/\D/g, "");
    //     if (formattedToNumber.startsWith("91") && formattedToNumber.length === 12) {
    //     formattedToNumber = formattedToNumber.slice(2);
    //     }

    //     if (formattedToNumber.length !== 10) {
    //     throw new Error(`Invalid Indian mobile: ${formattedToNumber}`);
    //     }

    //     const formattedFromNumber = EXOTEL_PHONE_NUMBER.replace(/\D/g, "");
    //     const authHeader = Buffer.from(`${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}`).toString("base64");

    //     const payload = querystring.stringify({
    //     From: formattedFromNumber,
    //     To: formattedToNumber,
    //     CallerId: formattedFromNumber,
    //     recordingChannels: "dual",
    //     TimeLimit: 3600,
    //     Record: "true",
    //     Timeout: 30,
    //     CallType: "trans",
    //     CustomFields: JSON.stringify({
    //         agentId,
    //         elevenLabsVoiceId,
    //         elevenLabsSpeed,
    //         elevenLabsStability,
    //         elevenLabsSimilarityBoost,
    //         sarvamVoice,
    //         transcriberProvider,
    //         transcriberLanguage,
    //         transcriberModel,
    //         aiModel,
    //         temperature,
    //         systemPrompt,
    //         firstMessage,
    //         maxTokens,
    //     }),
    //     });

    //     const response = await fetch(
    //     `https://api.exotel.com/v1/Accounts/${EXOTEL_SID}/Calls/connect.json`,
    //     {
    //         method: "POST",
    //         headers: {
    //         "Authorization": `Basic ${authHeader}`,
    //         "Content-Type": "application/x-www-form-urlencoded",
    //         "Accept": "application/json",
    //         },
    //         body: payload,
    //     }
    //     );

    //     const responseText = await response.text();

    //     if (!response.ok) {
    //     throw new Error(`Exotel API error: ${response.status} - ${responseText}`);
    //     }

    //     const callData = JSON.parse(responseText);
    //     const callSid = callData.Call?.Sid || callData.Sid;
        
    //     if (!callSid) {
    //     throw new Error("No Call SID returned");
    //     }

    //     await saveCallSettings(callSid, {
    //     agentId,
    //     elevenLabsVoiceId,
    //     elevenLabsSpeed: elevenLabsSpeed || 1.0,
    //     elevenLabsStability: elevenLabsStability || 0.7,
    //     elevenLabsSimilarityBoost: elevenLabsSimilarityBoost || 0.7,
    //     sarvamVoice: (typeof sarvamVoice === "string" && sarvamVoice.trim()) ? sarvamVoice.trim() : "Karun",
    //     transcriberProvider,
    //     transcriberLanguage,
    //     transcriberModel,
    //     aiModel,
    //     temperature: Number.isFinite(parseFloat(temperature)) ? parseFloat(temperature) : 0.7,
    //     systemPrompt: enhancedSystemPrompt,
    //     firstMessage,
    //     maxTokens: Number.isInteger(parseInt(maxTokens, 10)) ? parseInt(maxTokens, 10) : CONFIG.OPENAI_MAX_TOKENS_NORMAL,
    //     calendarConfig,
    //     knowledgeChunks,
    //     provider: "exotel"
    //     });

    //     stateManager.metrics.totalCalls++;
    //     stateManager.metrics.activeCalls++;

    //     reply.send({
    //     success: true,
    //     callSid,
    //     to: toNumber,
    //     provider: "exotel",
    //     });

    // } catch (err) {
    //     console.error("❌ Call creation failed:", err);
    //     stateManager.metrics.errors++;
    //     reply.code(500).send({ 
    //     error: "Failed to create call", 
    //     details: err.message 
    //     });
    // }
    // });

    fastify.post("/call-exotel", async (request, reply) => {
  const {
    // 📞 Call target
    number: toNumber,
    agentId,

    // 🔑 Exotel creds (ONLY source of truth)
    exotelAccountSid,
    exotelApiKey,
    exotelApiToken,
    exotelPhoneNumber,

    // 🤖 AI / Voice config
    elevenLabsVoiceId,
    elevenLabsSpeed,
    elevenLabsStability,
    elevenLabsSimilarityBoost,
    sarvamVoice,
    transcriberProvider,
    transcriberLanguage,
    transcriberModel,
    aiModel,
    temperature,
    systemPrompt,
    firstMessage,
    maxTokens,
  } = request.body;

  /* ------------------------------------------------------------------ */
  /* 🔒 HARD VALIDATION (NO ENV, NO FALLBACK)                             */
  /* ------------------------------------------------------------------ */

  if (!agentId) {
    return reply.code(400).send({ error: "agentId is required" });
  }

  if (
    !exotelAccountSid ||
    !exotelApiKey ||
    !exotelApiToken ||
    !exotelPhoneNumber
  ) {
    return reply.code(400).send({
      error: "Exotel credentials must be provided in request body",
    });
  }

  if (!toNumber || !/^\+?[1-9]\d{9,14}$/.test(toNumber)) {
    return reply.code(400).send({ error: "Invalid phone number" });
  }

  // Rate limiting
  if (!stateManager.checkRateLimit(toNumber)) {
    return reply.code(429).send({ error: "Rate limit exceeded" });
  }

  // Concurrent calls
  if (stateManager.metrics.activeCalls >= CONFIG.MAX_CONCURRENT_CALLS) {
    return reply.code(503).send({ error: "Maximum concurrent calls reached" });
  }

  try {
    /* ------------------------------------------------------------------ */
    /* 🧠 Load agent context                                               */
    /* ------------------------------------------------------------------ */

    const [calendarConfig, knowledgeChunks] = await Promise.all([
      getAgentCalendarConfig(agentId),
      preFetchAgentKnowledge(agentId),
    ]);

    const enhancedSystemPrompt = createEnhancedSystemPrompt(
      systemPrompt || "You are a helpful AI assistant.",
      calendarConfig
    );

    /* ------------------------------------------------------------------ */
    /* 📞 Normalize numbers (India)                                        */
    /* ------------------------------------------------------------------ */

    let formattedTo = toNumber.replace(/\D/g, "");
    if (formattedTo.startsWith("91") && formattedTo.length === 12) {
      formattedTo = formattedTo.slice(2);
    }

    if (formattedTo.length !== 10) {
      return reply.code(400).send({
        error: `Invalid Indian mobile number: ${formattedTo}`,
      });
    }

    const formattedFrom = exotelPhoneNumber.replace(/\D/g, "");

    /* ------------------------------------------------------------------ */
    /* 🔐 Exotel auth (REQUEST ONLY)                                       */
    /* ------------------------------------------------------------------ */

    const authHeader = Buffer.from(
      `${exotelApiKey}:${exotelApiToken}`
    ).toString("base64");

    /* ------------------------------------------------------------------ */
    /* 📦 Exotel payload                                                   */
    /* ------------------------------------------------------------------ */

    const payload = querystring.stringify({
      From: formattedFrom,
      To: formattedTo,
      CallerId: formattedFrom,
      Record: "true",
      Timeout: 30,
      CallType: "trans",

      CustomFields: JSON.stringify({
        agentId,
        elevenLabsVoiceId,
        elevenLabsSpeed,
        elevenLabsStability,
        elevenLabsSimilarityBoost,
        sarvamVoice,
        transcriberProvider,
        transcriberLanguage,
        transcriberModel,
        aiModel,
        temperature,
        systemPrompt,
        firstMessage,
        maxTokens,
      }),
    });

    /* ------------------------------------------------------------------ */
    /* 🚀 Exotel API call (SID FROM REQUEST)                               */
    /* ------------------------------------------------------------------ */

    const response = await fetch(
      `https://api.exotel.com/v1/Accounts/${exotelAccountSid}/Calls/connect.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: payload,
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      return reply.code(500).send({
        error: "Exotel API error",
        details: responseText,
      });
    }

    const callData = JSON.parse(responseText);
    const callSid = callData.Call?.Sid || callData.Sid;

    if (!callSid) {
      return reply.code(500).send({
        error: "No Call SID returned by Exotel",
      });
    }

    /* ------------------------------------------------------------------ */
    /* 💾 Save call settings                                               */
    /* ------------------------------------------------------------------ */

    await saveCallSettings(callSid, {
      agentId,
      elevenLabsVoiceId,
      elevenLabsSpeed: elevenLabsSpeed ?? 1.0,
      elevenLabsStability: elevenLabsStability ?? 0.7,
      elevenLabsSimilarityBoost: elevenLabsSimilarityBoost ?? 0.7,
      sarvamVoice:
        typeof sarvamVoice === "string" && sarvamVoice.trim()
          ? sarvamVoice.trim().toLowerCase()
          : "karun",  // Default to lowercase "karun"
      transcriberProvider,
      transcriberLanguage,
      transcriberModel,
      aiModel,
      temperature: Number.isFinite(parseFloat(temperature))
        ? parseFloat(temperature)
        : 0.7,
      systemPrompt: enhancedSystemPrompt,
      firstMessage,
      maxTokens: Number.isInteger(parseInt(maxTokens, 10))
        ? parseInt(maxTokens, 10)
        : CONFIG.OPENAI_MAX_TOKENS_NORMAL,
      calendarConfig,
      knowledgeChunks,
      provider: "exotel",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    });
    
    const finalVoice = typeof sarvamVoice === "string" && sarvamVoice.trim() ? sarvamVoice.trim().toLowerCase() : "karun";
    // console.log(`✅ Call created with Sarvam voice: "${finalVoice}"`);
    const langBase = (transcriberLanguage || "kn").split("-")[0];
const willUseSarvam = SARVAM_LANGS.includes(langBase);

if (willUseSarvam) {
  console.log(`✅ Call created → Using Sarvam voice: "${finalVoice}"`);
} else {
  console.log(`✅ Call created → Using ElevenLabs voiceId: "${elevenLabsVoiceId}"`);
}
    stateManager.metrics.totalCalls++;
    stateManager.metrics.activeCalls++;

    /* ------------------------------------------------------------------ */
    /* ✅ SUCCESS                                                          */
    /* ------------------------------------------------------------------ */

    return reply.send({
      success: true,
      callSid,
      to: toNumber,
      provider: "exotel",
    });
  } catch (err) {
    console.error("❌ Call creation failed:", err);
    stateManager.metrics.errors++;

    return reply.code(500).send({
      error: "Failed to create call",
      details: err.message,
    });
  }
});


    fastify.all("/exotel-answer", async (req, reply) => {
    const callSid = req.query?.CallSid || req.body?.CallSid;
    console.log(`📞 Inbound call: ${callSid}`);
    
    reply.type("text/xml").send(`
    <Response>
    <Connect>
        <Stream url="wss://${DOMAIN}/ws-exotel" bidirectional="true" />
    </Connect>
    </Response>
    `);
    });

    // ============================================================================
    // 🌐 WEBSOCKET HANDLER (Optimized)
    // ============================================================================

    fastify.register(async function (f) {
    f.get("/ws-exotel", { websocket: true }, (exotelWs, req) => {
        console.log("\n🔗 WebSocket connected");

        let deepgramWs = null;
        let silenceTimer = null;
        let silenceHangupTimer = null;
        
        const state = {
        streamSid: null,
        callSid: null,
        botSpeaking: false,
        userSpeaking: false,
        hasReceivedUserAudio: false,
        interrupted: false,
        lastUserActivity: Date.now(),
        sessionStartTime: Date.now(),
        currentTranscript: "",
        fullTranscript: [],
        metrics: { interruptsCount: 0, messagesCount: 0 },
        sarvamSpeaking: false,
        audioQueue: [],
        activeTTSAbort: null,
        // Turn control (prevents multiple responses per utterance)
        pendingFinalText: "",
        finalDebounceTimer: null,
        turnSeq: 0,
        activeTurnAbort: null,
        callEnding: false,
        };

        const queueTurnFromFinal = (finalPiece) => {
        const piece = finalPiece?.trim();
        if (!piece) return;

        state.pendingFinalText = state.pendingFinalText
            ? `${state.pendingFinalText} ${piece}`
            : piece;

        if (state.finalDebounceTimer) clearTimeout(state.finalDebounceTimer);

        // Debounce multiple "final" chunks into one utterance.
        // 800ms is a good balance between merging sub-phrases
        // (e.g. "Hello. Can" + "you hear me?") and responsiveness.
        state.finalDebounceTimer = setTimeout(() => {
            const utterance = state.pendingFinalText.trim();
            state.pendingFinalText = "";
            state.finalDebounceTimer = null;
            if (!utterance) return;

            // Abort any in-progress AI generation so we only respond once
            if (state.activeTurnAbort) {
            try { state.activeTurnAbort.abort(); } catch {}
            state.activeTurnAbort = null;
            }

            // Also interrupt TTS immediately if it was speaking
            if (state.activeTTSAbort) {
            try { state.activeTTSAbort.abort(); } catch {}
            state.activeTTSAbort = null;
            }
            if (state.botSpeaking) {
            state.interrupted = true;
            state.botSpeaking = false;
            state.sarvamSpeaking = false;
            sendClearEvent(exotelWs, state.streamSid);
            }

            state.turnSeq++;
            state.activeTurnAbort = new AbortController();

            state.fullTranscript.push({
            role: "user",
            text: utterance,
            timestamp: Date.now() - state.sessionStartTime,
            });
            state.metrics.messagesCount++;

            // Run turn (fire-and-forget) under single-flight control
            processTurn(utterance, state, exotelWs);
        }, 800);
        };

        const connectDeepgram = async (sampleRate = 8000) => {
        if (!state.streamSid) return;

        const settings = await getCallSettings(state.streamSid, state.callSid);
        if (!settings) return;

        deepgramWs = deepgram.listen.live({
            model: settings?.transcriberModel || "nova-2-general",
            language: settings?.transcriberLanguage || "en",
            encoding: "linear16",
            sample_rate: sampleRate,
            interim_results: CONFIG.DEEPGRAM_INTERIM_RESULTS,
            smart_format: true,
            endpointing: CONFIG.DEEPGRAM_ENDPOINTING,
            vad_events: true,
        });

        deepgramWs.on(LiveTranscriptionEvents.Open, () => {
            console.log("✅ Deepgram connected");
        });

        deepgramWs.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel?.alternatives?.[0]?.transcript || "";
            const isFinal = data.is_final;

            // Any detected speech while bot is speaking should interrupt fast
            if (transcript && state.botSpeaking && !state.interrupted) {
                console.log(`🛑 INTERRUPT: "${transcript}"`);
                state.interrupted = true;
                state.botSpeaking = false;
                state.sarvamSpeaking = false;
                sendClearEvent(exotelWs, state.streamSid);
                setImmediate(() => sendClearEvent(exotelWs, state.streamSid));

                if (state.activeTTSAbort) {
                state.activeTTSAbort.abort();
                state.activeTTSAbort = null;
                }
                if (state.activeTurnAbort) {
                try { state.activeTurnAbort.abort(); } catch {}
                state.activeTurnAbort = null;
                }

                state.metrics.interruptsCount++;
            }

            if (transcript) {
            state.currentTranscript = transcript;
            if (!isFinal) {
                console.log(`📝 ${transcript}`);
            }
            }

            if (isFinal && transcript.trim()) {
            state.userSpeaking = false;
            const finalText = transcript.trim();
            state.currentTranscript = "";
            state.lastUserActivity = Date.now();

            // Merge multiple final chunks, respond once
            queueTurnFromFinal(finalText);
            }
        });

        deepgramWs.on(LiveTranscriptionEvents.Close, () => {
            console.log("🔌 Deepgram closed");
        });

       deepgramWs.on(LiveTranscriptionEvents.Error, (err) => {
  console.error("❌ Deepgram error:", err);
       });
        };

        exotelWs.on("message", async (raw) => {
        try {
            const evt = JSON.parse(raw.toString());

            if (evt.event === "connected") {
            console.log("✅ Exotel connected");
            return;
            }

            if (evt.event === "start") {
            state.streamSid = evt.start.stream_sid;
            state.callSid = evt.start.call_sid;

            console.log(`🎯 Start | stream=${state.streamSid}, call=${state.callSid}`);

            // Map to parent call
            let latestCallSid = null;
            let latestTime = 0;

            for (const [sid, settings] of callSettings.entries()) {
                if (settings.createdAt && 
                    (Date.now() - settings.createdAt) < 30000 && 
                    settings.agentId !== 'default') {
                if (settings.createdAt > latestTime) {
                    latestTime = settings.createdAt;
                    latestCallSid = sid;
                }
                }
            }

            if (latestCallSid) {
                streamToCallMap.set(state.streamSid, latestCallSid);
                console.log(`🔗 Mapped ${state.streamSid} → ${latestCallSid}`);
            } else {
                console.log(`📞 Inbound call: ${state.callSid}`);
                
                // if (!callSettings.has(state.callSid)) {
                // const settings = {
                //     agentId: process.env.DEFAULT_AGENT_ID || 'default',
                //     aiModel: "gpt-4o-mini",
                //     temperature: 0.7,
                //     systemPrompt: "You are a helpful AI assistant.",
                //     firstMessage: "Hello! How can I help you?",
                //     maxTokens: 50,
                //     sarvamVoice: process.env.DEFAULT_SARVAM_VOICE || "Karun",
                //     transcriberLanguage: process.env.DEFAULT_TRANSCRIBER_LANGUAGE || "en",
                //     callType: "inbound",
                //     createdAt: Date.now(),
                //     lastAccessed: Date.now()
                // };
                
                // callSettings.set(state.callSid, settings);
                // }

                if (!callSettings.has(state.callSid)) {
  console.log("📞 Inbound Exotel call detected");

  const exotelNumber =
    evt.start.to || evt.start.called || evt.start.caller_id;

  const inboundSettings = await loadInboundSettingsByPhone(exotelNumber);

  if (!inboundSettings) {
    console.error(`❌ No inbound config for ${exotelNumber}`);

    callSettings.set(state.callSid, {
      agentId: "default",
      systemPrompt: "You are a helpful AI assistant.",
      firstMessage: "Hello! How can I help you?",
      callType: "inbound",
      createdAt: Date.now(),
    });
  } else {
    await saveCallSettings(state.callSid, inboundSettings);
    console.log(
      `✅ Inbound agent loaded: ${inboundSettings.agentId}`
    );
  }
}

                
                streamToCallMap.set(state.streamSid, state.callSid);
            }

            const sampleRate = evt.start.media_format?.sample_rate || 8000;
            await connectDeepgram(sampleRate);

            // Start silence keepalive
            if (!silenceTimer) {
                silenceTimer = setInterval(() => {
                if (
                    exotelWs.readyState === 1 &&
                    state.streamSid &&
                    !state.sarvamSpeaking &&
                    !state.userSpeaking
                ) {
                    exotelWs.send(JSON.stringify({
                    event: "media",
                    stream_sid: state.streamSid,
                    media: {
                        payload: Buffer.alloc(3200, 0x00).toString("base64")
                    }
                    }));
                }
                }, CONFIG.SILENCE_INTERVAL_MS);
            }

            // Silence hangup timer
          if (!silenceHangupTimer) {
  silenceHangupTimer = setInterval(async () => {

    if (
      exotelWs.readyState !== WebSocket.OPEN ||
      state.callEnding
    ) return;

    const silenceDuration = Date.now() - state.lastUserActivity;

    console.log(
      "Silence:", silenceDuration,
      "BotSpeaking:", state.botSpeaking,
      "CallEnding:", state.callEnding
    );

    if (
      silenceDuration > 15000 &&
      !state.botSpeaking
    ) {
      console.log("📞 Silence detected for 15 seconds.");

      state.callEnding = true;
      clearInterval(silenceHangupTimer);

      await speakText(
        "I did not hear anything from you. I will end the call now. Goodbye.",
        state,
        exotelWs,
        { aggressive: true }
      );

      await sleep(2000);

      await endCall(state, exotelWs, "silence_timeout");
    }

  }, 1000);
}

            // Send greeting for inbound
            const settings = await getCallSettings(state.streamSid, state.callSid);
            if (settings) {
                const isInbound = settings.callType === "inbound";
                
                if (isInbound && settings?.firstMessage) {
                setTimeout(async () => {
                    try {
                    // await speakText(settings.firstMessage, state, exotelWs, {
                    //     voiceId: settings.elevenLabsVoiceId || "hpp4J3VqNfWAUOO0d1Us",
                    //     aggressive: true
                    // });
//                     await speakText(settings.firstMessage, state, exotelWs, {
//   language: settings.transcriberLanguage,
//   voice: (settings.sarvamVoice || "arya").toLowerCase(),  // Normalize to lowercase
//   aggressive: true
// });
// const selectedVoice = (settings.sarvamVoice || "arya").toLowerCase();
const selectedVoice = settings.elevenLabsVoiceId || "hpp4J3VqNfWAUOO0d1Us";
const selectedLanguage = settings.sarvamLanguage || settings.transcriberLanguage || "kn";

console.log("🎙️ ===== INBOUND GREETING DEBUG =====");
console.log("Call SID:", state.callSid);
console.log("Agent ID:", settings.agentId);
console.log("Call Type:", settings.callType);
console.log("Selected Voice:", selectedVoice);
console.log("Selected Language:", selectedLanguage);
console.log("First Message:", settings.firstMessage);

   console.log("🟡 ===== FINAL GREETING VALUES =====");
      console.log("Voice used:", selectedVoice);
      console.log("Language used:", selectedLanguage);
      console.log("=====================================");
console.log("=====================================");

// await speakText(settings.firstMessage, state, exotelWs, {
//   language: selectedLanguage,
//   voiceId: selectedVoice,
//   aggressive: true
// });
const isSarvamLang = useSarvam(selectedLanguage);

await speakText(settings.firstMessage, state, exotelWs, 
  isSarvamLang
    ? {
        language: selectedLanguage,
        voice: settings.sarvamVoice?.toLowerCase() || "karun",
        aggressive: true
      }
    : {
        language: selectedLanguage,
        voiceId: settings.elevenLabsVoiceId,
        aggressive: true
      }
);


                    } catch (error) {
                    console.error("Greeting error:", error);
                    }
                }, 1000); // Reduced from 1500ms
                }
            }
            
            return;
            }

            if (evt.event === "media") {
            state.hasReceivedUserAudio = true;
            state.userSpeaking = true;
            state.lastUserActivity = Date.now();

            if (deepgramWs?.getReadyState() === 1) {
                deepgramWs.send(Buffer.from(evt.media.payload, "base64"));
            }
            return;
            }

            if (evt.event === "stop") {
            cleanup();
            return;
            }
        } catch (err) {
            console.error("❌ WS message error:", err);
        }
        });

        exotelWs.on("close", () => {
        console.log("📞 WebSocket closed");
        cleanup();
        });

        const cleanup = () => {
        if (silenceTimer) clearInterval(silenceTimer);
        if (silenceHangupTimer) clearInterval(silenceHangupTimer);
        if (state.finalDebounceTimer) clearTimeout(state.finalDebounceTimer);

        if (deepgramWs?.getReadyState() === 1) {
            try {
            deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
            } catch {}
        }

        if (state.activeTurnAbort) {
            try { state.activeTurnAbort.abort(); } catch {}
            state.activeTurnAbort = null;
        }
        if (state.activeTTSAbort) {
            try { state.activeTTSAbort.abort(); } catch {}
            state.activeTTSAbort = null;
        }

        if (state.callSid && callSettings.has(state.callSid)) {
            const settings = callSettings.get(state.callSid);
            if (settings?.callType === "inbound") {
            setTimeout(() => {
                callSettings.delete(state.callSid);
            }, 30000);
            }
        }

        stateManager.metrics.activeCalls = Math.max(0, stateManager.metrics.activeCalls - 1);
        };
    });
    });

    // ============================================================================
    // 📊 MONITORING & HEALTH
    // ============================================================================

    fastify.get("/health", async (req, reply) => {
    const metrics = stateManager.getMetrics();
    const ttsMetrics = ttsManager.getMetrics();
    
    reply.send({
        status: "healthy",
        timestamp: new Date().toISOString(),
        metrics: {
        ...metrics,
        tts: ttsMetrics,
        },
        config: {
        interruptThreshold: CONFIG.INTERRUPT_THRESHOLD_MS,
        wordThreshold: CONFIG.OPENAI_STREAMING_WORD_THRESHOLD,
        maxConcurrentCalls: CONFIG.MAX_CONCURRENT_CALLS,
        }
    });
    });

    fastify.get("/metrics", async (req, reply) => {
    reply.send(stateManager.getMetrics());
    });

    // ============================================================================
    // 🔧 HELPER FUNCTIONS (Calendar, etc.)
    // ============================================================================

    const API_BASE_URL = 'https://callagent.zoptrix.com/api';

    function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
    const currentTime = new Date().toISOString();
    const agentTimezone = calendarConfig?.effective_timezone || 'UTC';
    
    return `${baseSystemPrompt}

    Current UTC time: ${currentTime}
    Agent timezone: ${agentTimezone}

    Keep responses extremely concise (1-2 sentences). Speak naturally like a human in conversation.
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
            reason: { type: "string" },
            message: { type: "string" }
            },
            required: ["reason", "message"]
        }
        },
    ];

    if (calendarConfig?.calendar_access_token) {
        baseFunctions.push({
        name: "schedule_meeting",
        description: "Schedule a meeting",
        parameters: {
            type: "object",
            properties: {
            email: { type: "string" },
            datetime: { type: "string" },
            location: { type: "string" },
            purpose: { type: "string", default: "discovery call" },
            },
            required: ["email", "datetime", "location"]
        }
        });
    }

    return baseFunctions;
    }

    const getAgentCalendarConfig = async (agentId) => {
    try {
        const response = await fetch(`${API_BASE_URL}/${agentId}/calendar-config`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
        });

        if (!response.ok) return null;

        const data = await response.json();
        if (data?.agent_id) {
        return {
            agent_id: data.agent_id,
            agent_name: data.name,
            calendar_provider: data.provider,
            calendar_access_token: data.access_token,
            effective_timezone: data.calendar_timezone || data.agent_timezone || 'UTC',
            user_id: data.user_id,
        };
        }

        return null;
    } catch (error) {
        console.error("Calendar config error:", error);
        return null;
    }
    };




    // ============================================================================
    // 🚀 EXPORT
    // ============================================================================
async function loadInboundSettingsByPhone(exotelNumber) {
  const result = await db.query(`
    SELECT ic.*, a.*
    FROM inbound_configs ic
    JOIN agents a ON a.id = ic.agent_id::uuid
    WHERE ic.phone_number = $1
  `, [exotelNumber]);

  if (!result.rows.length) return null;

  const row = result.rows[0];

  const [calendarConfig, knowledgeChunks] = await Promise.all([
    getAgentCalendarConfig(row.agent_id),
    preFetchAgentKnowledge(row.agent_id),
  ]);

  // ✅ SAFE extraction (no assumptions)
  const agentPrompt =
    row.conversation_config?.agent?.prompt?.prompt ||
    "You are a helpful AI assistant.";

  const firstMessage =
    row.conversation_config?.agent?.first_message ||
    row.greeting_message ||
    "Hello! How can I help you today?";

// Extract from conversation_config (SINGLE SOURCE OF TRUTH)
const agentLanguage =
  row.conversation_config?.agent?.language ||
  row.conversation_config?.asr?.language ||
  "kn";

const agentVoice =
  row.conversation_config?.tts?.voice_id ||
  "karun";
console.log("🟢 ===== INBOUND SETTINGS DEBUG =====");
console.log("Phone:", exotelNumber);
console.log("Agent ID:", row.agent_id);
console.log("Voice from conversation_config:", agentVoice);
console.log("Language from conversation_config:", agentLanguage);
console.log("ASR Model:", row.conversation_config?.asr?.model);
console.log("=====================================");

return {
  agentId: row.agent_id,
  agentName: row.name,
  aiModel: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 180,
  systemPrompt: createEnhancedSystemPrompt(agentPrompt, calendarConfig),
  agentPrompt,
  firstMessage,
  calendarConfig,
  knowledgeChunks,
  elevenLabsVoiceId: agentVoice, 
  sarvamVoice: agentVoice,
  sarvamLanguage: agentLanguage,
  transcriberLanguage: agentLanguage,
  transcriberModel: row.conversation_config?.asr?.model || "nova-3",
  callType: "inbound",
  provider: "exotel",
  createdAt: Date.now(),
  lastAccessed: Date.now(),
};
}
    }

    // For standalone usage
    if (import.meta.url === `file://${process.argv[1]}`) {
    console.log("🚀 Starting production AI agent server...");
    // Add your Fastify server startup code here
    }