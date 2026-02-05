
// import OpenAI from "openai";
// import dotenv from "dotenv";
// import querystring from "querystring";
// import dns from "dns";
// import { SarvamAIClient } from "sarvamai";
// import { Readable } from "stream";
// dns.setDefaultResultOrder("ipv4first");
// dotenv.config({ path: ".env.production" });
// import workflowRoutes from '../routes/workflowRoutes.js';
// import workflowController from '../controllers/workflowController.js';
// import workflowModel from '../models/workflowModel.js';
// dotenv.config();
// import { DateTime } from "luxon";
// const { Pinecone } = await import("@pinecone-database/pinecone");
// import { createClient } from "@deepgram/sdk";
// import { LiveTranscriptionEvents } from "@deepgram/sdk";
// import WebSocket from "ws";
// import { Buffer } from "buffer";
// import ffmpeg from "fluent-ffmpeg";
// import ffmpegPath from "ffmpeg-static"; // ✅ ADD THIS

// ffmpeg.setFfmpegPath(ffmpegPath); 
// const pinecone = new Pinecone();
// const index = pinecone.Index("knowledge-base");
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// const PORT = process.env.PORT || 8080;
// const DOMAIN = process.env.NGROK_URL;

// // Exotel credentials from your .env
// const EXOTEL_SID = process.env.EXOTEL_SID || "exotel_sid";
// const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY || "1676c8f86ae4204d1cfcdda40c60510afc237499ae74635f";
// const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN || "e198511228fbeccc64ea61fa9e37cfc721d5404955983d09";
// const EXOTEL_PHONE_NUMBER = process.env.EXOTEL_PHONE_NUMBER || "080-473-62167";


// export async function registerExotel(fastify,deps) {

//   const { sessions, callSettings, streamToCallMap } = deps;
// // const sessions = new Map();
// const embeddingCache = new Map();

// function mp3Base64ToPcm(mp3Base64) {
//   const mp3Buffer = Buffer.from(mp3Base64, "base64");
//   return new Promise((resolve, reject) => {
//     const pcmChunks = [];
//     ffmpeg(Readable.from(mp3Buffer))
//       .inputFormat("mp3")
//       .audioChannels(1)
//       .audioFrequency(8000)
//       .audioCodec("pcm_s16le")
//       .format("s16le")
//       .on("error", reject)
//       .pipe()
//       .on("data", chunk => pcmChunks.push(chunk))
//       .on("end", () => resolve(Buffer.concat(pcmChunks)));
//   });
// }


// class SarvamTTS {
//   constructor(apiKey) {
//     this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
//     this.model = "bulbul:v2";
//   }

//   async generateAndStream(text, options = {}, exotelWs, state) {
//     const socket = await this.client.textToSpeechStreaming.connect({
//       model: this.model,
//       send_completion_event: true,
//     });

//     await socket.waitForOpen();

//     socket.configureConnection({
//       type: "config",
//       data: {
//         target_language_code: options.languageCode || "kn-IN",
//         speaker: options.voice || "anushka",
//         pitch: 0,
//         pace: 1,
//         output_audio_codec: "mp3", // ✅ Sarvam outputs MP3
//         speech_sample_rate: "8000",
//         min_buffer_size: 50,
//         max_chunk_length: 150
//       }
//     });

//     socket.on("message", async (msg) => {
//       if (msg.type === "audio" && msg.data?.audio && 
//           exotelWs.readyState === WebSocket.OPEN && 
//           !state.interrupted) {
//         // MP3 → PCM conversion (use your existing mp3Base64ToPcm)
//         const pcm = await mp3Base64ToPcm(msg.data.audio);
        
//         exotelWs.send(JSON.stringify({
//           event: "media",
//           stream_sid: state.streamSid,
//           media: { payload: pcm.toString("base64") }
//         }));
//       }
//     });
//     socket.convert(text.trim());
//     socket.flush();
//   }
// }



// const sarvamTTS = new SarvamTTS(process.env.SARVAM_API_KEY);

// const SARVAM_LANGS = ["kn", "te", "mr", "gu", "bn", "ml", "pa"];

// function useSarvam(language) {
//   const base = language?.split("-")[0];
//   return SARVAM_LANGS.includes(base);
// }


// class ElevenLabsTTSManager {
//   constructor(apiKey) {
//     this.apiKey = apiKey;
//     this.metrics = {
//       totalRequests: 0,
//       avgLatency: 0,
//       errors: 0,
//     };
//   }

// async generateSpeech(text, options = {},abortSignal = null) {
//   const {
//     voiceId = "21m00Tcm4TlvDq8ikWAM",
//     model = "eleven_turbo_v2_5",  
//     stability = 1.0,
//     similarityBoost = 0.8,
//     speed = 1.0,
//     style = 0.0,
//     aggressive = true,
//     outputFormat = "pcm_16000"
//   } = options;

//   const startTime = Date.now();
//   this.metrics.totalRequests++;

//   return new Promise((resolve, reject) => {
//     let firstByteTime = null;
//     let wsError = false;
//     const audioChunks = [];

//     // ✅ BALANCED CHUNKING - Not too aggressive
//     const chunkSchedule = aggressive
//       ? [50, 60, 70, 80] // ✅ BETTER BALANCE (was [30, 30, 30, 30])
//       : [120, 160, 250, 290];

//     if (!text || text.trim().length === 0) {
//       return reject(new Error("Text cannot be empty"));
//     }

//     const uri =
//       `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
//       `?model_id=${model}&output_format=${outputFormat}`;

//     const ws = new WebSocket(uri, {
//       headers: { "xi-api-key": this.apiKey },
//       perMessageDeflate: false,
//       maxPayload: 10 * 1024 * 1024,
//     });

//     const timeout = setTimeout(() => {
//       if (!firstByteTime && !wsError) {
//         wsError = true;
//         ws.close();
//         this.metrics.errors++;
//         console.error("❌ TTS timeout: no first byte in 5 seconds");
//         reject(new Error("TTS timeout: no first byte in 5 seconds"));
//       }
//     }, 5000);

//     ws.on("open", () => {
//       if (abortSignal) {
//   abortSignal.addEventListener("abort", () => {
//     try {
//       ws.close();
//     } catch {}
//   });
// }

//       console.log(`📡 ElevenLabs WS opened for: "${text.substring(0, 40)}..."`);
//       const payload = {
//         text: text.trim(),
//         voice_settings: {
//           stability,
//           similarity_boost: similarityBoost,
//           style, 
//           speed,
//           use_speaker_boost: false,
//         },
//         generation_config: {
//           chunk_length_schedule: chunkSchedule,
//         },
//       };

//       console.log(`📤 Sending TTS payload...`);
//       ws.send(JSON.stringify(payload), (err) => {
//         if (err) {
//           console.error(`❌ Error sending payload: ${err.message}`);
//           wsError = true;
//           return reject(err);
//         }
//         console.log(`✅ Payload sent, sending close signal...`);

//         ws.send(JSON.stringify({ text: "" }), (err2) => {
//           if (err2 && !wsError) {
//             console.error(`❌ Error sending close signal: ${err2.message}`);
//             wsError = true;
//             reject(err2);
//           }
//         });
//       });
//     });

//     ws.on("message", (rawData) => {
//       if (wsError) return;

//       try {
//         const message = JSON.parse(rawData.toString());

//         if (message.audio && !firstByteTime) {
//           firstByteTime = Date.now() - startTime;
//           console.log(`⏱️  TTS first byte: ${firstByteTime}ms`);
//         }

//         if (message.audio) {
//           const chunk = Buffer.from(message.audio, "base64");
//           audioChunks.push(chunk);
//           console.log(`📦 Audio chunk received: ${chunk.length} bytes`);
//         }

//         if (message.warning) {
//           console.warn(`⚠️  TTS warning: ${message.warning}`);
//         }

//         if (message.error) {
//           console.error(`❌ TTS error from ElevenLabs: ${message.error}`);
//           wsError = true;
//           reject(new Error(`ElevenLabs error: ${message.error}`));
//         }
//       } catch (e) {
//         if (e instanceof SyntaxError) return;
//         console.error("TTS parse error:", e.message);
//       }
//     });

//     ws.on("close", () => {
//       clearTimeout(timeout);
//       console.log(`🔌 ElevenLabs WS closed. Audio chunks received: ${audioChunks.length}`);

//       if (wsError) return;

//       if (audioChunks.length === 0) {
//         this.metrics.errors++;
//         console.error(`❌ No audio data received from ElevenLabs`);
//         console.error(`   Text was: "${text.substring(0, 100)}..."`);
//         console.error(`   Model: ${model}, Format: ${outputFormat}`);
//         return reject(new Error("No audio chunks received from TTS"));
//       }

//       const audio = Buffer.concat(audioChunks);
//       const totalTime = Date.now() - startTime;

//       this.metrics.avgLatency =
//         (this.metrics.avgLatency * (this.metrics.totalRequests - 1) +
//           totalTime) /
//         this.metrics.totalRequests;

//       console.log(`✅ TTS complete: ${audio.length} bytes in ${totalTime}ms`);
//       resolve(audio);
//     });

//     ws.on("error", (err) => {
//       clearTimeout(timeout);
//       if (!wsError) {
//         wsError = true;
//         this.metrics.errors++;
//         console.error(`❌ ElevenLabs WebSocket error: ${err.message}`);
//         reject(err);
//       }
//     });
//   });
// }
//   getMetrics() {
//     return { ...this.metrics };
//   }
// }
// const ttsManager = new ElevenLabsTTSManager(process.env.ELEVENLABS_API_KEY);

// function linear16ToMulaw(pcm16Buffer) {
//   const BIAS = 0x84;
//   const CLIP = 32635;

//   const pcm = new Int16Array(
//     pcm16Buffer.buffer,
//     pcm16Buffer.byteOffset,
//     pcm16Buffer.length / 2
//   );

//   const mulaw = Buffer.alloc(pcm.length);

//   for (let i = 0; i < pcm.length; i++) {
//     let sample = pcm[i];
//     let sign = (sample >> 8) & 0x80;
//     if (sign) sample = -sample;
//     if (sample > CLIP) sample = CLIP;

//     sample += BIAS;

//     let exponent = 7;
//     for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
//       exponent--;
//     }

//     let mantissa = (sample >> (exponent + 3)) & 0x0F;
//     mulaw[i] = ~(sign | (exponent << 4) | mantissa);
//   }

//   return mulaw;
// }


// async function getActiveWorkflowForAgent(agentId) {
//   const workflow = await workflowController.getActiveWorkflowForAgent(agentId);
//   return workflow ? await workflowModel.getWorkflowWithNodesAndEdges(workflow.id) : null;
// }

// function determineNextNode(workflow, currentNodeId, response, userInput) {
//   const currentNode = workflow.nodes.find(n => n.id === currentNodeId);
//   if (!currentNode) return null;
//   const outgoingEdges = workflow.edges.filter(e => e.from_node_id === currentNodeId);
//   if (outgoingEdges.length === 1) return outgoingEdges[0].to_node_id;
//   for (const edge of outgoingEdges) {
//     if (edge.condition?.type === 'direct') return edge.to_node_id;
//     if (edge.condition?.intent && userInput.toLowerCase().includes(edge.condition.intent.toLowerCase())) {
//       return edge.to_node_id;
//     }
//   }
//   return outgoingEdges[0]?.to_node_id || null;
// }

// async function extractVariables(text, plan) {
//   if (!plan?.output || plan.output.length === 0) return {};
//   try {
//     const prompt = `Extract the following variables from the text: ${JSON.stringify(plan.output)}
// Text: "${text}"
// Respond with only a JSON object containing the extracted variables.`;
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4",
//       messages: [{ role: "user", content: prompt }],
//       temperature: 0.1,
//     });
//     return JSON.parse(completion.choices[0].message.content);
//   } catch (error) {
//     console.error('Error extracting variables:', error);
//     return {};
//   }
// }

// async function aiResponse(
//   ws,
//   messages,
//   model,
//   temperature,
//   maxTokens,
//   state,
//   exotelWs,
//   ttsLanguage
// ) {
//   const stream = await openai.chat.completions.create({
//     model,
//     temperature,
//     max_tokens: maxTokens,
//     messages,
//     stream: true,
//   });

//   const sarvam = useSarvam(ttsLanguage);

//   let fullMessage = "";
//   let ttsBuffer = "";
//   let earlyTtsStarted = false;

//   for await (const chunk of stream) {
//     const token = chunk.choices?.[0]?.delta?.content ?? "";
//     if (!token) continue;

//     const clean = token
//       .replace(/^(\s*[-*+]|\s*\d+\.)\s+/g, "")
//       .replace(/[*_~`>#]/g, "")
//       .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

//     fullMessage += clean;

//     // 🔊 ONLY stream to ElevenLabs
//     if (!sarvam) {
//       ttsBuffer += clean;

//       if (!earlyTtsStarted && ttsBuffer.split(/\s+/).length >= 12) {
//         earlyTtsStarted = true;
//         await queueSpeak(ttsBuffer, state, exotelWs);
//         ttsBuffer = "";
//       }
//     }

//     ws.send(JSON.stringify({
//       type: "text",
//       token: clean,
//       last: false
//     }));
//   }

//   ws.send(JSON.stringify({ type: "text", token: "", last: true }));

//   // 🔊 Final TTS
//   if (!state.interrupted) {
//     if (sarvam) {
//       // ✅ Sarvam gets FULL sentence only
//       await queueSpeak(fullMessage, state, exotelWs);
//     } else if (ttsBuffer.trim()) {
//       await queueSpeak(ttsBuffer, state, exotelWs);
//     }
//   }

//   return fullMessage;
// }


// async function embedText(text) {
//   const cacheKey = text.toLowerCase().trim();
//   if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey);
//   const embed = await openai.embeddings.create({
//     model: "text-embedding-3-small",
//     input: text,
//   });
//   const result = embed.data[0].embedding;
//   embeddingCache.set(cacheKey, result);
//   return result;
// }

// // async function preFetchAgentKnowledge(agentId) {
// //   try {
// //     const stats = await index.describeIndexStats();
// //     const vectorCount = stats.namespaces[agentId]?.vectorCount || 1000;
// //     const queryEmbedding = await embedText("general query");
// //     const results = await index.query({
// //       vector: queryEmbedding,
// //       topK: Math.min(vectorCount, 5000),
// //       includeMetadata: true,
// //       filter: { agent_id: agentId },
// //     });
// //     return results.matches.map(match => ({
// //       content: match.metadata.content,
// //       embedding: match.values
// //     }));
// //   } catch (error) {
// //     console.error('Error pre-fetching knowledge:', error);
// //     return [];
// //   }
// // }

// async function preFetchAgentKnowledge(agentId) {
//   try {
//     const queryEmbedding = await embedText(
//       "Monospear Technologies company information"
//     );

//     const results = await index.query({
//       vector: queryEmbedding,
//       topK: 5, // ✅ ideal for voice AI
//       includeMetadata: true,
//       filter: { agent_id: agentId },
//     });

//     console.log("🧠 KB PREFETCH:", {
//       agentId,
//       count: results.matches.length,
//       sample: results.matches[0]?.metadata?.content?.slice(0, 120)
//     });

//     return results.matches.map(match => ({
//       content: match.metadata.content,
//       embedding: match.values
//     }));
//   } catch (error) {
//     console.error("❌ Error pre-fetching knowledge:", error);
//     return [];
//   }
// }




// async function executeNodeActions(actions, extractedVariables, callSid) {
//   if (!actions) return;
//   try {
//     console.log('🔄 Executing actions:', actions);
//     if (actions.send_calendar_invite) console.log('📅 Sending calendar invite');
//     if (actions.update_crm) console.log('💼 Updating CRM');
//   } catch (error) {
//     console.error('❌ Error executing actions:', error);
//   }
// }



// function detectCustomerTimezone(location) {
//   const locationTimezones = {
//     'London': 'Europe/London',
//     'Manchester': 'Europe/London',
//     'Brighton': 'Europe/London',
//     'New York': 'America/New_York',
//     'Los Angeles': 'America/Los_Angeles',
//     'Paris': 'Europe/Paris',
//     'Berlin': 'Europe/Berlin',
//     'Tokyo': 'Asia/Tokyo',
//     'Mumbai': 'Asia/Kolkata',
//     'Delhi': 'Asia/Kolkata',
//     'Bangalore': 'Asia/Kolkata',
//     'Hyderabad': 'Asia/Kolkata',
//     'Kolkata': 'Asia/Kolkata',
//     'Chennai': 'Asia/Kolkata',
//     'Sydney': 'Australia/Sydney'
//   };

//   return locationTimezones[location] || 'UTC';
// }

// function formatTimeInTimezone(utcDatetime, timezone) {
//   try {
//     const date = new Date(utcDatetime);
//     return date.toLocaleString('en-US', {
//       timeZone: timezone,
//       weekday: 'long',
//       year: 'numeric',
//       month: 'long',
//       day: 'numeric',
//       hour: '2-digit',
//       minute: '2-digit',
//       timeZoneName: 'short'
//     });
//   } catch (error) {
//     console.error('Error formatting time in timezone:', error);
//     return utcDatetime.toString();
//   }
// }

// const API_BASE_URL = 'https://callagent.zoptrix.com/api';

// function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
//   const currentTime = new Date().toISOString();
//   const agentTimezone = calendarConfig?.effective_timezone || 'UTC';
  
//   const agentLocalTime = new Date().toLocaleString('en-US', {
//     timeZone: agentTimezone,
//     weekday: 'long',
//     year: 'numeric',
//     month: 'long',
//     day: 'numeric',
//     hour: 'numeric',
//     minute: 'numeric',
//     hour12: true,
//   });

//   return `
// ${baseSystemPrompt}

// You are a helpful AI assistant that schedules calls and collects customer details accurately. The current UTC time is: ${currentTime}. The current time in your timezone (${agentTimezone}) is: ${agentLocalTime}.

// **Core Behavior:**
// - Be patient, conversational, and human-like in your interactions
// - Take time to ensure accuracy - it's better to double-check than to make mistakes
// - Only proceed when you're confident the information is correct
// - Show empathy and understanding when customers make mistakes or need to repeat information

// **Email Collection Process:**
// When collecting email addresses, be thorough but natural:

// **Understanding Email Components:**
// - Recognize that customers may say "at" or "at sign" instead of "@"
// - Understand "dot com", "dot org", "dot net", "dot co dot uk", etc. as domain extensions
// - Be aware of common email providers: gmail, yahoo, hotmail, outlook, icloud, etc.

// **Step-by-Step Collection:**
// 1. **Collect the username part:**
//    - "Could you please spell out the first part of your email address, before the @ symbol? Please go slowly so I can get it exactly right."
//    - Listen for: letters, numbers, periods, underscores, hyphens
//    - If they say "at" during this part, gently redirect: "I'll get the @ symbol in a moment, let's just focus on the part before that first."

// 2. **Confirm the username:**
//    - Repeat back letter by letter: "Let me confirm - that's [spell out each letter], is that correct?"
//    - If wrong or unclear: "No problem, let's try that part again. Could you spell it out once more, nice and slowly?"

// 3. **Collect the domain part:**
//    - "Great! Now could you spell out the part after the @ symbol, including the domain like gmail dot com?"
//    - **Listen carefully for:**
//      - "at" or "at sign" = @
//      - "dot" = .
//      - "dot com" = .com
//      - "dot org" = .org
//      - "dot net" = .net
//      - "dot co dot uk" = .co.uk
//      - "dot edu" = .edu
//    - Common domains: gmail, yahoo, hotmail, outlook, icloud, monospear, company names

// 4. **Intelligent interpretation:**
//    - If customer says: "john at gmail dot com" → interpret as "john@gmail.com"
//    - If customer says: "smith underscore marketing at company dot co dot uk" → interpret as "smith_marketing@company.co.uk"
//    - If customer spells: "g-m-a-i-l dot c-o-m" → interpret as "gmail.com"

// 5. **Confirm the domain:**
//    - Repeat back: "So that's [domain name] dot [extension], is that correct?"
//    - Example: "So that's gmail dot com, is that correct?"

// 6. **Final confirmation:**
//    - Read back the complete email address in a natural way
//    - Example: "Perfect! So your complete email address is john at gmail dot com - is that exactly right?"

// **Error Handling & Corrections:**
// - If you mishear or misunderstand, apologize and ask for clarification
// - If correcting only a part, be specific: "Let me just double-check the domain part..." 
// - Be patient with spelling variations and accents
// - If unsure about unusual domains, ask: "Just to confirm, is that [unusual domain] dot [extension]?"

// **Common Email Patterns to Recognize:**
// - firstname.lastname@company.com
// - firstname_lastname@domain.com  
// - firstnamelastname@gmail.com
// - nickname123@yahoo.com
// - initial.lastname@company.co.uk

// **Meeting Scheduling:**
// - When collecting date/time preferences, be flexible and conversational
// - Check availability against the calendar and offer alternatives if needed
// - Confirm timezone clearly to avoid confusion
// - Make sure the customer is comfortable with the final time

// **Final Confirmation & Tool Call:**
// - Only call the schedule_meeting tool after you have confirmed ALL required information is correct
// - The customer should explicitly confirm each piece of information before you proceed
// - If anything seems unclear or potentially wrong, take the time to clarify first
// - Do not rush to the tool call - accuracy is more important than speed

// **Error Handling:**
// - If you mishear or misunderstand something, apologize and ask them to repeat it
// - If the customer corrects something, thank them and update your understanding
// - Take your time - there's no rush in getting accurate information

// Remember: Your goal is to be helpful and accurate, not fast. A patient, thorough approach will lead to better results and happier customers.
// `;
// }

// // function createEnhancedSystemPrompt(baseSystemPrompt, calendarConfig) {
// //   const currentTime = new Date().toISOString();
  
// //   // SIMPLIFIED VERSION
// //   return `
// // ${baseSystemPrompt}

// // Current time: ${currentTime}

// // Keep responses brief and conversational. Speak naturally as if on a phone call.
// // `;
// // }

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
//   {
//     name: "hangUp",
//     description: "End the call politely when the user shows no interest or the conversation is complete",
//     parameters: {
//       type: "object",
//       properties: {
//         reason: {
//           type: "string",
//           description: "Reason for ending the call (e.g. 'not interested', 'already has service', 'goodbye')."
//         },
//         message: {
//           type: "string",
//           description: "Polite final message to say before hanging up"
//         }
//       },
//       required: ["reason", "message"]
//     }
//   },
//   ];

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

// const getAgentCalendarConfig = async (agentId) => {
//   console.log("agentid", agentId)
//   try {
//     console.log(`🔍 Fetching calendar config for agent ${agentId}`);

//     const response = await fetch(`${API_BASE_URL}/${agentId}/calendar-config`, {
//       method: 'GET',
//       headers: {
//         'Content-Type': 'application/json',
//         'Accept': 'application/json'
//       }
//     });

//     if (!response.ok) {
//       if (response.status === 404) {
//         console.log(`Agent ${agentId} not found or has no calendar configuration ${response}`);
//         return null;
//       }
//       throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//     }

//     const data = await response.json();
//     console.log("agen data", data)
//     if (data && data.agent_id) {
//       const effectiveTimezone = data.calendar_timezone || data.agent_timezone || 'UTC';

//       return {
//         agent_id: data.agent_id,
//         agent_name: data.name,
//         calendar_provider: data.provider,
//         calendar_access_token: data.access_token,
//         calendar_refresh_token: data.refresh_token,
//         calendar_email: data.email,
//         effective_timezone: effectiveTimezone,
//         user_id: data.user_id,
//       };
//     }

//     return null;
//   } catch (error) {
//     console.error("Error fetching agent calendar config:", error);
//     return null;
//   }
// };

// const saveExtractedDetailsWithTimezone = async (callSid, extractedDetails, calendarConfig) => {
//   try {
//     const payload = {
//       call_sid: callSid,
//       email: extractedDetails.email,
//       appointment_time: extractedDetails.appointmentTime,
//       location: extractedDetails.location,
//       purpose: extractedDetails.purpose,
//       has_confirmation: extractedDetails.hasConfirmation,
//       customer_timezone: extractedDetails.customerTimezone,
//       agent_id: extractedDetails.agentId,
//       meeting_id: extractedDetails.meetingId,
//       extraction_timestamp: new Date().toISOString(),
//       status: 'scheduled',
//     };

//     const response = await fetch(`${API_BASE_URL}/save-extracted-details`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify(payload)
//     });

//     if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

//     const savedDetails = await response.json();
//     console.log('✅ Extracted details saved successfully:', savedDetails);

//     const meetPayload = {
//       duration: extractedDetails.duration || 30, 
//       subject: extractedDetails.subject,
//       description: extractedDetails.description,
//       extractedId: savedDetails.data.id || 37,
//       callId: callSid,
//       contactId: extractedDetails.contactId || null
//     };
    
//     console.log("meetpayload", meetPayload)
//     const meetResponse = await fetch(`${API_BASE_URL}/schedule/meet`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify(meetPayload)
//     });

//     if (!meetResponse.ok) throw new Error(`Meeting API failed: ${meetResponse.statusText}`);

//     const meetResult = await meetResponse.json();
//     console.log('✅ Meeting scheduled successfully:', meetResult);

//     return savedDetails;

//   } catch (error) {
//     console.error('❌ Error in save and schedule flow:', error);
//     throw error;
//   }
// };

// async function checkCalendarAvailability(calendarConfig, requestedDateTime, durationMinutes = 30) {
//   try {
//     const startTime = new Date(requestedDateTime);
//     const endTime = new Date(startTime.getTime() + (durationMinutes * 60000));

//     let availabilityResult;

//     switch (calendarConfig.calendar_provider) {
//       case 'google':
//         availabilityResult = await checkGoogleCalendarAvailability(calendarConfig, startTime, endTime);
//         break;
//       case 'outlook':
//         availabilityResult = await checkOutlookCalendarAvailability(calendarConfig, startTime, endTime);
//         break;
//       default:
//         availabilityResult = {
//           available: Math.random() > 0.3,
//           conflictingEvents: [],
//           provider: 'mock'
//         };
//     }

//     return availabilityResult;
//   } catch (error) {
//     console.error("Error checking calendar availability:", error);
//     return {
//       available: false,
//       error: "Unable to check calendar availability",
//       conflictingEvents: []
//     };
//   }
// }

// async function checkGoogleCalendarAvailability(calendarConfig, startTime, endTime) {
//   try {
//     const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${calendarConfig.calendar_access_token}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         timeMin: startTime.toISOString(),
//         timeMax: endTime.toISOString(),
//         items: [
//           { id: calendarConfig.calendar_email || 'primary' }
//         ]
//       })
//     });

//     const result = await response.json();

//     if (!response.ok) {
//       throw new Error(result.error?.message || 'Failed to check availability');
//     }

//     const calendarId = calendarConfig.calendar_email || 'primary';
//     const busyTimes = result.calendars[calendarId]?.busy || [];

//     const hasConflict = busyTimes.some(busyPeriod => {
//       const busyStart = new Date(busyPeriod.start);
//       const busyEnd = new Date(busyPeriod.end);
//       return (startTime < busyEnd && endTime > busyStart);
//     });

//     return {
//       available: !hasConflict,
//       conflictingEvents: busyTimes,
//       provider: 'google'
//     };

//   } catch (error) {
//     console.error("Google Calendar availability check error:", error);
//     return {
//       available: false,
//       error: error.message,
//       conflictingEvents: []
//     };
//   }
// }

// async function checkOutlookCalendarAvailability(calendarConfig, startTime, endTime) {
//   try {
//     const response = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${calendarConfig.calendar_access_token}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         schedules: [calendarConfig.calendar_email || 'me'],
//         startTime: {
//           dateTime: startTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         endTime: {
//           dateTime: endTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         availabilityViewInterval: 30
//       })
//     });

//     const result = await response.json();

//     if (!response.ok) {
//       throw new Error(result.error?.message || 'Failed to check Outlook availability');
//     }

//     const busyTimes = result.value?.[0]?.busyViewEntries || [];
//     const hasConflict = busyTimes.some(entry => entry.status === 'busy');

//     return {
//       available: !hasConflict,
//       conflictingEvents: busyTimes,
//       provider: 'outlook'
//     };

//   } catch (error) {
//     console.error("Outlook Calendar availability check error:", error);
//     return {
//       available: false,
//       error: error.message,
//       conflictingEvents: []
//     };
//   }
// }

// async function scheduleGoogleCalendarMeeting(meetingData, description) {
//   try {
//     const startTime = new Date(meetingData.datetime);
//     const endTime = new Date(startTime.getTime() + 30 * 60000);

//     const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${meetingData.calendarConfig.calendar_access_token}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         summary: `${meetingData.purpose} - ${meetingData.location}`,
//         description: description,
//         start: {
//           dateTime: startTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         end: {
//           dateTime: endTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         attendees: [
//           {
//             email: meetingData.email,
//             displayName: 'Customer'
//           },
//           {
//             email: meetingData.calendarConfig.calendar_email,
//             displayName: meetingData.agentName
//           }
//         ],
//         location: meetingData.location,
//         reminders: {
//           useDefault: false,
//           overrides: [
//             { method: 'email', minutes: 24 * 60 },
//             { method: 'popup', minutes: 15 }
//           ]
//         }
//       })
//     });

//     const result = await response.json();

//     if (response.ok) {
//       return {
//         success: true,
//         meetingId: result.id,
//         meetingLink: result.htmlLink
//       };
//     } else {
//       return {
//         success: false,
//         error: result.error?.message || 'Failed to create calendar event'
//       };
//     }
//   } catch (error) {
//     console.error("Google Calendar API error:", error);
//     return {
//       success: false,
//       error: "Google Calendar service unavailable"
//     };
//   }
// }

// async function scheduleOutlookCalendarMeeting(meetingData, description) {
//   try {
//     const startTime = new Date(meetingData.datetime);
//     const endTime = new Date(startTime.getTime() + 30 * 60000);

//     const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${meetingData.calendarConfig.calendar_access_token}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         subject: `${meetingData.purpose} - ${meetingData.location}`,
//         body: {
//           contentType: 'HTML',
//           content: description
//         },
//         start: {
//           dateTime: startTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         end: {
//           dateTime: endTime.toISOString(),
//           timeZone: 'UTC'
//         },
//         attendees: [
//           {
//             emailAddress: {
//               address: meetingData.email,
//               name: 'Customer'
//             },
//             type: 'required'
//           }
//         ],
//         location: {
//           displayName: meetingData.location
//         },
//         reminderMinutesBeforeStart: 15
//       })
//     });

//     const result = await response.json();

//     if (response.ok) {
//       return {
//         success: true,
//         meetingId: result.id,
//         meetingLink: result.webLink
//       };
//     } else {
//       return {
//         success: false,
//         error: result.error?.message || 'Failed to create Outlook calendar event'
//       };
//     }
//   } catch (error) {
//     console.error("Outlook Calendar API error:", error);
//     return {
//       success: false,
//       error: "Outlook Calendar service unavailable"
//     };
//   }
// }

// async function suggestAlternativeTimesWithTimezone(calendarConfig, requestedDateTimeUTC, customerTimezone, agentTimezone, maxSuggestions = 3) {
//   try {
//     const alternatives = [];
//     const baseDate = new Date(requestedDateTimeUTC);

//     const businessHours = [9, 10, 11, 14, 15, 16];

//     for (let dayOffset = 0; dayOffset < 7 && alternatives.length < maxSuggestions; dayOffset++) {
//       const checkDate = new Date(baseDate);
//       checkDate.setDate(baseDate.getDate() + dayOffset);

//       if (checkDate.getDay() === 0 || checkDate.getDay() === 6) continue;

//       for (let i = 0; i < businessHours.length && alternatives.length < maxSuggestions; i++) {
//         const hour = businessHours[i];

//         const agentLocalTime = new Date(checkDate);
//         agentLocalTime.setHours(hour, 0, 0, 0);

//         const utcTime = convertToUTC(
//           agentLocalTime.toISOString().slice(0, 19).replace('T', ' '),
//           agentTimezone
//         );

//         if (utcTime <= new Date()) continue;

//         const availability = await checkCalendarAvailability(
//           calendarConfig,
//           utcTime.toISOString(),
//           30
//         );

//         if (availability.available) {
//           alternatives.push({
//             utcTime: utcTime.toISOString(),
//             agentTime: formatTimeInTimezone(utcTime, agentTimezone),
//             customerTime: formatTimeInTimezone(utcTime, customerTimezone)
//           });
//         }
//       }
//     }

//     return alternatives;
//   } catch (error) {
//     console.error("Error suggesting alternative times with timezone:", error);
//     return [];
//   }
// }

// async function scheduleCalendarMeetingWithTimezone(meetingData) {
//   try {
//     const { calendarConfig, customerTimezone, agentTimezone } = meetingData;

//     const description = `
// Meeting scheduled via outbound call

// Details:
// - Location: ${meetingData.location}
// - Purpose: ${meetingData.purpose}
// - Customer Email: ${meetingData.email}
// - Customer Timezone: ${customerTimezone}
// - Agent Timezone: ${agentTimezone}
// - Call SID: ${meetingData.callSid}

// Times:
// - Customer Time: ${formatTimeInTimezone(meetingData.datetime, customerTimezone)}
// - Agent Time: ${formatTimeInTimezone(meetingData.datetime, agentTimezone)}
// - UTC Time: ${meetingData.datetime}
//     `.trim();

//     let calendarResponse;

//     switch (calendarConfig.calendar_provider) {
//       case 'google':
//         calendarResponse = await scheduleGoogleCalendarMeeting(meetingData, description);
//         break;
//       case 'outlook':
//         calendarResponse = await scheduleOutlookCalendarMeeting(meetingData, description);
//         break;
//       default:
//         calendarResponse = {
//           success: true,
//           meetingId: `mock_meeting_${Date.now()}`,
//           meetingLink: `https://calendar.google.com/mock_meeting_${Date.now()}`
//         };
//     }

//     return calendarResponse;
//   } catch (error) {
//     console.error("Calendar scheduling error:", error);
//     return {
//       success: false,
//       error: "Calendar service unavailable"
//     };
//   }
// }

// async function getRelevantChunks(query, agentId, topK = 2) {
//   try {
//     const queryEmbedding = await embedText(query);
//     const results = await index.query({
//       vector: queryEmbedding,
//       topK: topK,
//       includeMetadata: true,
//       filter: { agent_id: agentId },
//     });
//     return results.matches.map(match => match.metadata.content);
//   } catch (error) {
//     console.error('Error getting relevant chunks:', error);
//     return [];
//   }
// }

// async function handleQuestionAnswer(query, settings) {
//   try {
//     // Use existing knowledge base search
//     const relevantChunks = await getRelevantChunks(query, settings.agentId, 2);

//     if (relevantChunks.length > 0) {
//       return {
//         success: true,
//         answer: relevantChunks[0],
//         source: "knowledge_base"
//       };
//     } else {
//       return {
//         success: true,
//         answer: "I don't have specific information about that. Let me help you with scheduling a meeting instead.",
//         source: "fallback"
//       };
//     }
//   } catch (error) {
//     return { error: "Failed to process question" };
//   }
// }

// async function handleScheduleMeeting(parameters, callSid, settings) {
//   try {
//     let { email, datetime, location, purpose = "discovery call", timezone: customerTimezone } = parameters;
//      email = email?.trim().toLowerCase();

//     if (!settings.calendarConfig || !settings.calendarConfig.calendar_access_token) {
//       return {
//         success: false,
//         message: "I apologize, but I'm unable to schedule meetings at the moment. Someone from our team will follow up with you to arrange a meeting."
//       };
//     }

//     if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
//       return { success: false, message: "Please provide a valid email address." };
//     }

//     const detectedCustomerTimezone = customerTimezone || detectCustomerTimezone(location);
//     const agentTimezone = settings.calendarConfig.effective_timezone || 'IST';
//     console.log(`🌍 Timezone info - Customer: ${detectedCustomerTimezone}, Agent: ${agentTimezone}`);

//     let meetingDateUTC;
//     if (!datetime) {
//       return { success: false, message: "Please provide a date and time for the meeting." };
//     }
    
//     if (datetime.includes("T")) {
//       meetingDateUTC = DateTime.fromISO(datetime, { zone: 'UTC' });
//     } else {
//       meetingDateUTC = DateTime.fromFormat(datetime, "yyyy-MM-dd HH:mm:ss", { zone: 'UTC' });
//     }

//     if (!meetingDateUTC.isValid) {
//       return { success: false, message: "Please provide date and time in a format like 'August 21, 2 PM 2025' or '2025-08-21 14:00'" };
//     }

//     if (meetingDateUTC <= DateTime.utc().plus({ minutes: 1 })) {
//       return { success: false, message: "Please choose a future date and time." };
//     }

//     const formattedDatetime = meetingDateUTC.toFormat("yyyy-MM-dd HH:mm:ss");

//     console.log(`🔍 Checking availability for ${meetingDateUTC.toISO()} (UTC)...`);
//     const availabilityCheck = await checkCalendarAvailability(
//       settings.calendarConfig,
//       meetingDateUTC.toISO(),
//       30
//     );

//     if (!availabilityCheck.available) {
//       const alternatives = await suggestAlternativeTimesWithTimezone(
//         settings.calendarConfig,
//         meetingDateUTC.toJSDate(),
//         detectedCustomerTimezone,
//         agentTimezone
//       );

//       const customerLocalTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), detectedCustomerTimezone);
//       const agentLocalTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), agentTimezone);
//       let message = `I'm sorry, but ${customerLocalTime} (${agentLocalTime} agent time) is not available.`;

//       if (alternatives.length > 0) {
//         message += ` How about one of these: ${alternatives.map(alt => alt.customerTime).join(', ')}?`;
//       } else {
//         message += ` Could you suggest a different time?`;
//       }

//       return { success: false, message, alternatives, conflictReason: availabilityCheck.error || 'Time slot occupied' };
//     }

//     console.log(`✅ Time slot available for ${meetingDateUTC.toISO()} (UTC)`);

//     settings.meetingData = {
//       email,
//       datetime: formattedDatetime,
//       location,
//       purpose,
//       customerTimezone: detectedCustomerTimezone,
//       agentTimezone,
//       agentId: settings.agentId,
//       agentName: settings.agentName,
//       agentEmail: settings.agentEmail,
//       confirmationAttempts: (settings.meetingData?.confirmationAttempts || 0) + 1
//     };

//     const scheduleResult = await scheduleCalendarMeetingWithTimezone({
//       email,
//       datetime: formattedDatetime,
//       location,
//       purpose,
//       customerTimezone: detectedCustomerTimezone,
//       agentTimezone,
//       agentId: settings.agentId,
//       agentName: settings.agentName,
//       agentEmail: settings.agentEmail,
//       callSid,
//       calendarConfig: settings.calendarConfig
//     });

//     if (scheduleResult.success) {
//       await saveExtractedDetailsWithTimezone(callSid, {
//         email,
//         appointmentTime: formattedDatetime,
//         location,
//         purpose,
//         hasConfirmation: true,
//         customerTimezone: detectedCustomerTimezone,
//         agentTimezone,
//         agentId: settings.agentId,
//         meetingId: scheduleResult.meetingId
//       }, settings.calendarConfig);

//       const customerTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), detectedCustomerTimezone);
//       const agentTime = formatTimeInTimezone(meetingDateUTC.toJSDate(), agentTimezone);

//       let confirmationMessage = `Perfect! I've scheduled your ${purpose} for ${customerTime}`;
//       if (detectedCustomerTimezone !== agentTimezone) {
//         confirmationMessage += ` (${agentTime} my time)`;
//       }
//       confirmationMessage += `You'll will receive a confirmation email at ${email}.`;

//       return { success: true, message: confirmationMessage, meetingId: scheduleResult.meetingId };
//     } else {
//       return { success: false, message: scheduleResult.error || "I'm having trouble scheduling. Could you try a different time?" };
//     }

//   } catch (error) {
//     console.error("Error scheduling meeting:", error);
//     return { success: false, message: "I encountered an error while scheduling. Could you please try again?" };
//   }
// }

// // const callSettings = new Map();
// async function handleHangUp(reason, callSid) {
//   try {
//     const settings = callSettings.get(callSid);

//     callSettings.delete(callSid);
//     sessions.delete(callSid);

//     console.log(`📞 Call ${callSid} ended. Reason: ${reason || 'user ended call'}`);
//     return {
//       success: true,
//       message: "Thank you for your time. Have a great day!",
//       action: "call_ended",
//       reason: reason || 'user ended call'
//     };
//   } catch (error) {
//     console.error("Error ending call:", error);
//     return { error: "Failed to end call" };
//   }
// }

// async function aiResponseWithFunctions(messages, model, temperature, maxTokens, availableFunctions) {
//   const completion = await openai.chat.completions.create({
//     model,
//     temperature,
//     max_tokens: maxTokens,
//     messages,
//     functions: availableFunctions,
//     function_call: "auto"
//   });

//   return completion.choices[0].message;
// }

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// const SHORT_AFFIRMATIONS = new Set([
//   "ok", "okay", "yeah", "yes", "yep", "no", "right", "sure", "got it"
// ]);

// function isShortAffirmation(text) {
//   return SHORT_AFFIRMATIONS.has(text.trim().toLowerCase());
// }

// function stripGreeting(text) {
//   return text.replace(/^(hi|hello|hey)[,!.\s]*/i, "").trim();
// }
// // async function processTurn(userText, state, exotelWs) {
// //   try {
// //     if (state.botSpeaking) state.interrupted = true;

// //     const callSid =
// //       streamToCallMap.get(state.streamSid) || state.callSid;
// //     if (!callSid) return;

// //     const settings = await getCallSettings(state.streamSid, callSid);
// //     if (!settings) return;

// //     const cleaned = userText?.trim();
// //     if (!cleaned) return;

// //     const words = cleaned.split(/\s+/).filter(Boolean);
// //     if (cleaned.length < 6 || words.length < 2) {
// //       console.log(`[EXOTEL SKIP short] "${cleaned}"`);
// //       return;
// //     }

// //     let conversation = sessions.get(callSid) || [];
// //     conversation.push({ role: "user", content: cleaned });

// //     const kbContext = settings.knowledgeChunks
// //       ?.slice(0, 4)
// //       ?.map(c => c.content)
// //       ?.join("\n\n───\n") || "";

// //     const systemPrompt = `
// // You are a calm, professional voice assistant.

// // Company knowledge (use when relevant):
// // ${kbContext || "(no company knowledge available)"}

// // Be concise and natural.
// // `.trim();

// //     const messages = [
// //       { role: "system", content: systemPrompt },
// //       ...conversation.slice(-10)
// //     ];

// //     const completion = await openai.chat.completions.create({
// //       model: settings.aiModel || "gpt-4o-mini",
// //       messages,
// //       temperature: settings.temperature || 0.7,
// //       max_tokens: state.interrupted ? 20 : 60
// //     });

// //     if (state.interrupted) return;

// //     const reply =
// //       completion.choices?.[0]?.message?.content?.trim() ||
// //       "Could you clarify that please?";

// //     conversation.push({ role: "assistant", content: reply });
// //     sessions.set(callSid, conversation);

// //     await speakText(reply, state, exotelWs, {
// //       voiceId: settings.elevenLabsVoiceId,
// //       aggressive: true
// //     });

// //   } catch (err) {
// //     console.error("❌ Exotel processTurn error:", err);
// //   } finally {
// //     state.interrupted = false;
// //     state.activeTTSAbort = null;
// //   }
// // }

// //   async function processTurn(userText, state, exotelWs) {
// //   try {
// //     if (state.botSpeaking) state.interrupted = true;

// //     const callSid =
// //       streamToCallMap.get(state.streamSid) || state.callSid;
// //     if (!callSid) return;

// //     // 1. Get settings with agent ID support (maintaining your existing parameters)
// //     const settings = await getCallSettings(state.streamSid, callSid);
// //     if (!settings) return;

// //     // Debug logging for KB
// //     console.log("=== EXOTEL KB DEBUG START ===");
// //     console.log("callSid:", callSid);
// //     console.log("agentId:", settings?.agentId);
// //     console.log("streamSid:", state.streamSid);
// //     console.log("knowledgeChunks length:", settings?.knowledgeChunks?.length || 0);
// //     if (settings?.knowledgeChunks?.length) {
// //       console.log("First KB chunk:", settings.knowledgeChunks[0].content.slice(0, 200));
// //     }
// //     console.log("=== EXOTEL KB DEBUG END ===");

// //     const cleaned = userText?.trim();
// //     if (!cleaned) return;

// //     const words = cleaned.split(/\s+/).filter(Boolean);
// //     if (cleaned.length < 6 || words.length < 2) {
// //       console.log(`[EXOTEL SKIP short] "${cleaned}"`);
// //       return;
// //     }

// //     let conversation = sessions.get(callSid) || [];
// //     conversation.push({ role: "user", content: cleaned });

// //     // 2. Build KB context with proper formatting
// //     const kbContext = settings.knowledgeChunks
// //       ?.slice(0, 4)
// //       ?.map(c => c.content)
// //       ?.join("\n\n") || "";

// //     // 3. Enhanced system prompt with agent customization
// //     const basePrompt = settings?.systemPrompt || 
// //       "You are a calm, professional voice assistant for Exotel calls.";
    
// //     const systemPrompt = `
// // ${basePrompt}

// // ${settings?.agentId ? `Agent Profile: ${settings.agentName || `Agent ID: ${settings.agentId}`}\n` : ""}

// // Company knowledge (use when relevant):
// // ${kbContext ? kbContext : "(No specific company knowledge available)"}

// // Guidelines:
// // - Be concise and natural in conversation
// // - Respond appropriately based on the context
// // - Use knowledge base only when relevant to the query
// // - Maintain professional tone throughout
// // `.trim();

// //     const messages = [
// //       { role: "system", content: systemPrompt },
// //       ...conversation.slice(-10)
// //     ];

// //     // 4. Use settings from frontend with fallbacks
// //     const completion = await openai.chat.completions.create({
// //       model: settings.aiModel || "gpt-4o-mini",
// //       messages,
// //       temperature: settings.temperature || 0.7,
// //       max_tokens: state.interrupted ? 
// //         Math.min(20, settings.maxTokens || 20) : 
// //         Math.min(60, settings.maxTokens || 60)
// //     });

// //     if (state.interrupted) return;

// //     const reply =
// //       completion.choices?.[0]?.message?.content?.trim() ||
// //       "Could you clarify that please?";

// //     conversation.push({ role: "assistant", content: reply });
// //     sessions.set(callSid, conversation);

// //     // 5. Enhanced TTS with ElevenLabs parameters from settings
// //     await speakText(reply, state, exotelWs, {
// //       voiceId: settings.elevenLabsVoiceId,
// //       stability: settings.elevenLabsStability || 0.7,
// //       similarityBoost: settings.elevenLabsSimilarityBoost || 0.7,
// //       speed: settings.elevenLabsSpeed ||0.85,
// //       aggressive: settings.elevenLabsAggressive || true,
// //       language: settings.transcriberLanguage,
// //       voice: "anushka"
// //     });
// //    console.log(
// //   `🎙️ TTS engine: ${
// //     useSarvam(settings.transcriberLanguage) ? "SARVAM" : "ELEVENLABS"
// //   } | lang=${settings.transcriberLanguage}`
// // );



// //     // Log the interaction
// //     console.log(`🤖 EXOTEL BOT (${settings.aiModel || 'gpt-4o-mini'}): "${reply}"`);

// //   } catch (err) {
// //     console.error("❌ Exotel processTurn error:", err);
// //     // Optionally send an error message to the user
// //     if (!state.interrupted) {
// //       try {
// //         await speakText("I encountered an issue. Please try again.", state, exotelWs, {
// //           voiceId: settings?.elevenLabsVoiceId,
// //           aggressive: true
// //         });
// //       } catch (ttsErr) {
// //         console.error("Failed to speak error message:", ttsErr);
// //       }
// //     }
// //   } finally {
// //     state.interrupted = false;
// //     state.activeTTSAbort = null;
// //   }
// // }

// async function processTurn(userText, state, exotelWs) {
//   try {
//     if (state.botSpeaking) state.interrupted = true;

//     const callSid = streamToCallMap.get(state.streamSid) || state.callSid;
//     if (!callSid) return;

//     const settings = await getCallSettings(state.streamSid, callSid);
//     if (!settings) return;

//     const cleaned = userText?.trim();
//     if (!cleaned) return; // Only skip if completely empty

//     // ✅ REMOVED: Don't filter based on length/word count
//     // const words = cleaned.split(/\s+/).filter(Boolean);
//     // if (cleaned.length < 6 || words.length < 2) {
//     //   console.log(`[EXOTEL SKIP short] "${cleaned}"`);
//     //   return;
//     // }

//     // ✅ INSTEAD: Handle short responses intelligently
//     const isShortGreeting = /^(hi|hello|hey|good\s*(morning|afternoon|evening))$/i.test(cleaned);
//     const isShortAffirmation = /^(yes|no|yeah|yep|nope|ok|okay|sure|right|got it|alright)$/i.test(cleaned);
    
//     if (isShortGreeting || isShortAffirmation) {
//       console.log(`👋 Detected short response: "${cleaned}" - Will respond appropriately`);
//     }

//     let conversation = sessions.get(callSid) || [];
//     conversation.push({ role: "user", content: cleaned });

//     // Debug logging for KB
//     console.log("=== EXOTEL KB DEBUG START ===");
//     console.log("callSid:", callSid);
//     console.log("agentId:", settings?.agentId);
//     console.log("streamSid:", state.streamSid);
//     console.log("knowledgeChunks length:", settings?.knowledgeChunks?.length || 0);
//     if (settings?.knowledgeChunks?.length) {
//       console.log("First KB chunk:", settings.knowledgeChunks[0].content.slice(0, 200));
//     }
//     console.log("=== EXOTEL KB DEBUG END ===");

//     // Build KB context with proper formatting
//     const kbContext = settings.knowledgeChunks
//       ?.slice(0, 4)
//       ?.map(c => c.content)
//       ?.join("\n\n") || "";

//     // Enhanced system prompt that handles short responses
//     const basePrompt = settings?.systemPrompt || 
//       "You are a calm, professional voice assistant for Exotel calls.";
    
//     const systemPrompt = `
// ${basePrompt}

// ${settings?.agentId ? `Agent Profile: ${settings.agentName || `Agent ID: ${settings.agentId}`}\n` : ""}

// Company knowledge (use when relevant):
// ${kbContext ? kbContext : "(No specific company knowledge available)"}

// Guidelines:
// - Be concise and natural in conversation
// - Respond appropriately based on the context
// - Use knowledge base only when relevant to the query
// - Maintain professional tone throughout
// - For short greetings like "hello" or "hi", respond with a friendly greeting
// - For short affirmations like "yes", "no", "okay", respond naturally and continue the conversation
// - Keep responses conversational even for single-word inputs
// `.trim();

//     const messages = [
//       { role: "system", content: systemPrompt },
//       ...conversation.slice(-10)
//     ];

//     // Use settings from frontend with fallbacks
//     const completion = await openai.chat.completions.create({
//       model: settings.aiModel || "gpt-4o-mini",
//       messages,
//       temperature: settings.temperature || 0.7,
//       max_tokens: state.interrupted ? 
//         Math.min(20, settings.maxTokens || 20) : 
//         Math.min(60, settings.maxTokens || 60)
//     });

//     if (state.interrupted) return;

//     const reply =
//       completion.choices?.[0]?.message?.content?.trim() ||
//       "Could you clarify that please?";

//     conversation.push({ role: "assistant", content: reply });
//     sessions.set(callSid, conversation);

//     // Enhanced TTS with ElevenLabs parameters from settings
//     await speakText(reply, state, exotelWs, {
//       voiceId: settings.elevenLabsVoiceId,
//       stability: settings.elevenLabsStability || 0.7,
//       similarityBoost: settings.elevenLabsSimilarityBoost || 0.7,
//       speed: settings.elevenLabsSpeed || 0.85,
//       aggressive: settings.elevenLabsAggressive || true,
//       language: settings.transcriberLanguage,
//       voice: "anushka"
//     });

//     console.log(
//       `🎙️ TTS engine: ${
//         useSarvam(settings.transcriberLanguage) ? "SARVAM" : "ELEVENLABS"
//       } | lang=${settings.transcriberLanguage}`
//     );

//     console.log(`🤖 EXOTEL BOT (${settings.aiModel || 'gpt-4o-mini'}): "${reply}"`);

//   } catch (err) {
//     console.error("❌ Exotel processTurn error:", err);
//     if (!state.interrupted) {
//       try {
//         await speakText("I encountered an issue. Please try again.", state, exotelWs, {
//           voiceId: settings?.elevenLabsVoiceId,
//           aggressive: true
//         });
//       } catch (ttsErr) {
//         console.error("Failed to speak error message:", ttsErr);
//       }
//     }
//   } finally {
//     state.interrupted = false;
//     state.activeTTSAbort = null;
//   }
// }

// // const streamToCallMap = new Map();

// async function saveCallSettings(callSid, data) {
//   data.createdAt = Date.now();
//   data.lastAccessed = Date.now();
//   callSettings.set(callSid, data);
//   console.log(`💾 SAVED ${callSid}: agentId=${data.agentId}, KB=${data.knowledgeChunks?.length || 0}`);
  
//   // Cleanup old entries (older than 5 minutes)
//   cleanupOldCallSettings();
// }

// function cleanupOldCallSettings() {
//   const now = Date.now();
//   for (const [callSid, settings] of callSettings.entries()) {
//     if (now - settings.createdAt > 5 * 60 * 1000) { // 5 minutes
//       callSettings.delete(callSid);
//       console.log(`🧹 Cleaned up old call settings: ${callSid}`);
//     }
//   }
// }

// async function getCallSettings(streamSid, incomingCallSid) {
//   // First try direct mapping
//   let callSid = streamToCallMap.get(streamSid);
  
//   if (callSid) {
//     const settings = callSettings.get(callSid);
//     if (settings) {
//       settings.lastAccessed = Date.now();
//       console.log(`✅ LOADED via direct mapping: ${streamSid}→${callSid} [${settings.callType || 'outbound'}]`);
//       return settings;
//     }
//   }
  
//   // Check if incomingCallSid exists in settings (inbound call)
//   if (incomingCallSid && callSettings.has(incomingCallSid)) {
//     const settings = callSettings.get(incomingCallSid);
//     if (settings && settings.callType === "inbound") {
//       streamToCallMap.set(streamSid, incomingCallSid);
//       settings.lastAccessed = Date.now();
//       console.log(`✅ LOADED inbound call: ${streamSid}→${incomingCallSid}`);
//       return settings;
//     }
//   }
  
//   // Fallback to most recent outbound call
//   let mostRecentSettings = null;
//   let mostRecentTime = 0;
//   let mostRecentCallSid = null;
  
//   for (const [storedCallSid, settings] of callSettings.entries()) {
//     // Look for outbound calls created in the last 30 seconds
//     if (settings.createdAt && 
//         (Date.now() - settings.createdAt) < 30000 &&
//         (!settings.callType || settings.callType === "outbound")) {
//       if (settings.createdAt > mostRecentTime) {
//         mostRecentTime = settings.createdAt;
//         mostRecentSettings = settings;
//         mostRecentCallSid = storedCallSid;
//       }
//     }
//   }
  
//   if (mostRecentSettings) {
//     streamToCallMap.set(streamSid, mostRecentCallSid);
//     mostRecentSettings.lastAccessed = Date.now();
//     console.log(`✅ Found recent outbound call ${mostRecentCallSid} for stream ${streamSid}`);
//     return mostRecentSettings;
//   }
  
//   console.log(`❌ No suitable call settings found for stream ${streamSid}`);
//   return null;
// }



// // fastify.all("/exotel-answer", async (req, reply) => {
// //   console.log("Exotel answer XML domain:", DOMAIN);

// //   const callSid = req.query?.CallSid || req.body?.CallSid;
  
// //   console.log(`📞 Exotel answer request for callSid: ${callSid}`);
  
// // reply
// //     .type("text/xml")
// //     .send(`
// // <Response>
// //   <Connect>
// //     <Stream
// //       url="wss://${DOMAIN}/ws-exotel"
// //       bidirectional="true"
// //     />
// //   </Connect>
// // </Response>
// // `);

// // });

// fastify.all("/exotel-answer", async (req, reply) => {
//   console.log("Exotel answer XML domain:", DOMAIN);

//   const callSid = req.query?.CallSid || req.body?.CallSid;
  
//   console.log(`📞 Exotel inbound call answer request for callSid: ${callSid}`);
  
//   // Clean up any old inbound call settings to avoid conflicts
//   for (const [sid, settings] of callSettings.entries()) {
//     if (settings.callType === "inbound" && (Date.now() - settings.createdAt) > 30000) {
//       callSettings.delete(sid);
//       console.log(`🧹 Cleaned up old inbound call settings: ${sid}`);
//     }
//   }
  
//   reply
//     .type("text/xml")
//     .send(`
// <Response>
//   <Connect>
//     <Stream
//       url="wss://${DOMAIN}/ws-exotel"
//       bidirectional="true"
//     />
//   </Connect>
// </Response>
// `);
// });
// // Add stream status callback
// fastify.post("/stream-status", async (req, reply) => {
//   console.log("📊 Stream status update:", req.body);
//   reply.send({ success: true });
// });

// // Add this debug function
// // Add this function to help debug
// function debugExotelCallFlow(apiCallSid, wsCallSid) {
//   console.log('\n🔍 DEBUG EXOTEL CALL FLOW:');
//   console.log(`- API created CallSid: ${apiCallSid}`);
//   console.log(`- WebSocket received CallSid: ${wsCallSid}`);
//   console.log(`- Are they the same? ${apiCallSid === wsCallSid ? 'YES ✅' : 'NO ❌'}`);
  
//   if (apiCallSid !== wsCallSid) {
//     console.log(`⚠️  This is Exotel's parent-child call structure.`);
//     console.log(`   The API returns a parent call, but the WebSocket gets a child call.`);
//     console.log(`   We need to match them by creation time.`);
//   }
  
//   // Check if we have the API call stored
//   const apiSettings = callSettings.get(apiCallSid);
//   console.log(`- API call stored? ${apiSettings ? 'YES ✅' : 'NO ❌'}`);
  
//   if (apiSettings) {
//     console.log(`  Created ${Math.round((Date.now() - apiSettings.createdAt)/1000)} seconds ago`);
//   }
  
//   console.log('---\n');
// }
// /* -------------------------------------------------------------------------- */
// /* ✅ /call-exotel — Outbound Call via Exotel                                 */
// /* -------------------------------------------------------------------------- */
// fastify.post("/call-exotel", async (request, reply) => {
//   const {
//     number: toNumber,
//     elevenLabsVoiceId,
//     elevenLabsSpeed,
//     elevenLabsStability,
//     elevenLabsSimilarityBoost,
//     transcriberProvider,
//     transcriberLanguage,
//     transcriberModel,
//     aiModel,
//     temperature,
//     systemPrompt,
//     firstMessage,
//     maxTokens,
//     agentId,
//   } = request.body;

//   // ALWAYS use env values
//   const exotelAccountSid = EXOTEL_SID;
//   const exotelApiKey = EXOTEL_API_KEY;
//   const exotelApiToken = EXOTEL_API_TOKEN;
//   const exotelPhoneNumber = EXOTEL_PHONE_NUMBER;
// if (!toNumber || !/^\+?[1-9]\d{9,14}$/.test(toNumber)) {
//   return reply.code(400).send({ error: "Invalid phone number format" });
// }


//   try {
//     // Fetch calendar + knowledge
//     const [calendarConfig, knowledgeChunks] = await Promise.all([
//       getAgentCalendarConfig(agentId),
//       preFetchAgentKnowledge(agentId),
//     ]);

//     const enhancedSystemPrompt = createEnhancedSystemPrompt(systemPrompt, calendarConfig);

//     const exotelApiUrl =
//       `https://api.exotel.com/v1/Accounts/${exotelAccountSid}/Calls/connect.json`;

//     // ✅ Format phone numbers correctly for Exotel
//   let formattedToNumber = toNumber.replace(/\D/g, "");

// // India-specific fix
// if (formattedToNumber.startsWith("91") && formattedToNumber.length === 12) {
//   formattedToNumber = formattedToNumber.slice(2);
// }

// if (formattedToNumber.length !== 10) {
//   throw new Error(`Invalid Indian mobile number: ${formattedToNumber}`);
// }


//     const formattedFromNumber = exotelPhoneNumber.replace(/\D/g, ""); // Remove all non-digits

//     console.log(`📞 Calling Exotel API: ${exotelApiUrl}`);
//     console.log(`📞 From: ${formattedFromNumber}, To: ${formattedToNumber}`);

//     const authHeader = Buffer.from(
//       `${exotelApiKey}:${exotelApiToken}`
//     ).toString("base64");

//     // ✅ FIXED: Don't try to include callSid in the request - we don't have it yet!
//     const payload = querystring.stringify({
//         From: formattedFromNumber,
//         To: formattedToNumber,
//         CallerId: formattedFromNumber,
//         recordingChannels: "dual",
//         // Url: `https://${DOMAIN}/exotel-answer`,
//         TimeLimit: 3600,
//         Record: "true",
//         Timeout: 30,  // Wait 30 seconds before considering no answer
//         CallType: "trans",  // Transactional call
//         CustomFields: JSON.stringify({
//         agentId,
//         elevenLabsVoiceId,
//         elevenLabsSpeed,
//         elevenLabsStability,
//         elevenLabsSimilarityBoost,
//         transcriberProvider,
//         transcriberLanguage,
//         transcriberModel,
//         aiModel,
//         temperature,
//         systemPrompt,
//         firstMessage,
//         maxTokens,
//       }),
//     });

//     const response = await fetch(exotelApiUrl, {
//       method: "POST",
//       headers: {
//         "Authorization": `Basic ${authHeader}`,
//         "Content-Type": "application/x-www-form-urlencoded",
//         "Accept": "application/json",
//       },
//       body: payload,
//     });

//     const responseText = await response.text();
//     console.log(`📞 Exotel API Response: ${response.status} - ${responseText}`);

//     if (!response.ok) {
//       throw new Error(`Exotel API error: ${response.status} - ${responseText}`);
//     }

//     let callData;
//     try {
//       callData = JSON.parse(responseText);
//     } catch (parseError) {
//       console.error("Failed to parse Exotel response:", responseText);
//       throw new Error(`Invalid JSON response from Exotel: ${responseText}`);
//     }

//     const callSid = callData.Call?.Sid || callData.Sid;
    
//     if (!callSid) {
//       console.error("Exotel response:", callData);
//       throw new Error("No Call SID returned from Exotel");
//     }

//     console.log(`📞 Exotel call created: ${toNumber} | SID: ${callSid}`);

//     // Save call settings
//     const settingsData = {
//       agentId,
//       elevenLabsVoiceId,
//       elevenLabsSpeed,
//       elevenLabsStability,
//       elevenLabsSimilarityBoost,
//       transcriberProvider,
//       transcriberLanguage,
//       transcriberModel,
//       aiModel,
//       temperature: parseFloat(temperature),
//       systemPrompt: enhancedSystemPrompt,
//       firstMessage,
//       maxTokens: parseInt(maxTokens, 10),
//       calendarConfig: calendarConfig || null,
//       knowledgeChunks,
//       exotelAccountSid,
//       exotelApiKey,
//       exotelApiToken,
//       provider: "exotel"
//     };

//     await saveCallSettings(callSid, settingsData);
    
//     console.log(`✅ callSettings saved for CallSid ${callSid}`);
// debugExotelCallFlow(callSid, null); // Log the API call
//     reply.send({
//       success: true,
//       callSid: callSid,
//       to: toNumber,
//       provider: "exotel",
//       exotelResponse: callData
//     });

//   } catch (err) {
//     console.error("❌ Failed to create Exotel call:", err);
//     reply.code(500).send({ 
//       error: "Failed to create Exotel call", 
//       details: err.message,
//       tip: "Check Exotel credentials and ensure account is active"
//     });
//   }
// });

// fastify.get("/health", async (req, reply) => {
//   const isHealthy = true; // Add actual health checks
//   reply.send({ 
//     status: isHealthy ? "healthy" : "unhealthy",
//     timestamp: new Date().toISOString(),
//     activeCalls: callSettings.size,
//     activeSessions: sessions.size
//   });
// });

// fastify.register(async function (f) {
//   f.get("/ws-exotel", { websocket: true }, (exotelWs, req) => {
//     console.log("\n🔗 Exotel WebSocket connected (/ws-exotel)");

//     let deepgramWs = null;
//     let silenceTimer = null;
//     const state = {
//       streamSid: null,
//       callSid: null,
//       botSpeaking: false,
//       userSpeaking: false,
//       hasReceivedUserAudio: false,
//       interrupted: false,
//       lastUserActivity: Date.now(),
//       sessionStartTime: Date.now(),
//       currentTranscript: "",
//       fullTranscript: [],
//       metrics: { interruptsCount: 0, messagesCount: 0 },
//       customParams: {},
//     };

//     /* -------------------------------------------------- */
//     /* 🔊 CONNECT DEEPGRAM                                */
//     /* -------------------------------------------------- */
//     const connectDeepgram = async (sampleRate = 8000) => {
//       if (!state.streamSid) return;

//       const settings = await getCallSettings(state.streamSid, state.callSid);
      
//       if (!settings) {
//         console.error(`❌ No settings found for stream ${state.streamSid}`);
//         return;
//       }

//       deepgramWs = deepgram.listen.live({
//         model: settings?.transcriberModel || "nova-2-general",
//         language: settings?.transcriberLanguage || "en-IN",
//         encoding: "linear16",
//         sample_rate: sampleRate,
//         interim_results: true,
//         smart_format: true,
//         endpointing: parseInt(process.env.INTERRUPT_THRESHOLD_MS) || 150,
//         vad_events: true,
//       });

//       deepgramWs.on(LiveTranscriptionEvents.Open, () => {
//         console.log("✅ Deepgram connected");
//       });

//      deepgramWs.on(LiveTranscriptionEvents.Transcript, (data) => {
//   const transcript =
//     data.channel?.alternatives?.[0]?.transcript || "";
//   const isFinal = data.is_final;
//   const isSpeechFinal = data.speech_final;

//   if (transcript && !state.userSpeaking) {
//     state.userSpeaking = true;

//     // ✅ IMPROVED INTERRUPTION HANDLING
//    if (state.botSpeaking) {
//   console.log(`🛑 USER INTERRUPTED HARD: "${transcript}"`);

//   state.interrupted = true;
//   state.botSpeaking = false;
//   state.audioQueue = [];
//   state.metrics.interruptsCount++;

//   // 🔥 HARD STOP AUDIO IMMEDIATELY
//   sendClearEvent(exotelWs, state.streamSid);

//   // 🔥 CANCEL ANY ACTIVE TTS
//   if (state.activeTTSAbort) {
//     state.activeTTSAbort.abort();
//     state.activeTTSAbort = null;
//   }
// }
//   }

//   if (transcript) {
//     state.currentTranscript = transcript;
//     console.log(`📝 ${transcript}${isFinal ? " [FINAL]" : ""}`);
//   }

//  // 🚀 RESPOND AS SOON AS DEEPGRAM FINALIZES (NO DELAY)
// if (data.is_final && transcript.trim()) {
//   state.userSpeaking = false;

//   const finalText = transcript.trim();
//   state.currentTranscript = "";
//   state.lastUserActivity = Date.now();

//   state.fullTranscript.push({
//     role: "user",
//     text: finalText,
//     timestamp: Date.now() - state.sessionStartTime,
//   });
//   state.metrics.messagesCount++;
//   // ❌ DO NOT RESET interrupted HERE
//   processTurn(finalText, state, exotelWs);
// }
// });

//       deepgramWs.on(LiveTranscriptionEvents.Close, () => {
//         console.log("🔌 Deepgram closed");
//       });

//       deepgramWs.on(LiveTranscriptionEvents.Error, (err) => {
//         console.error("❌ Deepgram error:", err);
//       });
//     };

//     /* -------------------------------------------------- */
//     /* 📡 EXOTEL EVENTS                                   */
//     /* -------------------------------------------------- */
//     exotelWs.on("message", async (raw) => {
//       try {
//         const evt = JSON.parse(raw.toString());

//         if (evt.event === "connected") {
//           console.log("✅ Exotel WS connected");
//           return;
//         }

//         /* ---------- START ---------- */
//         if (evt.event === "start") {
//           state.streamSid = evt.start.stream_sid;
//           state.callSid = evt.start.call_sid;

//           console.log(
//             `🎯 Start | streamSid=${state.streamSid}, callSid=${state.callSid}`
//           );

//           debugExotelCallFlow(null, state.callSid);

//           // Map to parent (keep your existing mapping logic)
//           let latestCallSid = null;
//           let latestTime = 0;

//           // First, check if this is an outbound call by looking for recent call settings
//           for (const [sid, settings] of callSettings.entries()) {
//             // Outbound calls have custom fields and agentId
//             if (settings.createdAt && 
//                 (Date.now() - settings.createdAt) < 30000 && // Last 30 seconds
//                 settings.agentId !== 'default') {
//               if (settings.createdAt > latestTime) {
//                 latestTime = settings.createdAt;
//                 latestCallSid = sid;
//               }
//             }
//           }

//           if (latestCallSid) {
//             // This is likely an outbound call - use the parent mapping
//             streamToCallMap.set(state.streamSid, latestCallSid);
//             console.log(`🔗 MAPPED outbound ${state.streamSid} → parent ${latestCallSid}`);
//           } else {
//             // This is likely an inbound call - store as is
//             console.log(`📞 This appears to be an inbound call: ${state.callSid}`);
            
//             // Check if we need to create inbound settings
//             if (!callSettings.has(state.callSid)) {
//               console.log(`📝 Creating inbound call settings for ${state.callSid}`);
              
//               // Try to get the agent ID from custom parameters if available
//               let agentId = process.env.DEFAULT_AGENT_ID || 'default';
              
//               // Check if there are any recent outbound calls to infer agent ID
//               for (const [sid, settings] of callSettings.entries()) {
//                 if (settings.createdAt && (Date.now() - settings.createdAt) < 60000) {
//                   agentId = settings.agentId;
//                   break;
//                 }
//               }
              
//               const settings = {
//                 agentId: agentId,
//                 aiModel: "gpt-4o-mini",
//                 temperature: 0.7,
//                 systemPrompt: "You are a helpful AI assistant. Answer customer questions politely and professionally.",
//                 firstMessage: "Hello! Thanks for calling. How can I help you today?",
//                 maxTokens: 256,
//                 callType: "inbound",
//                 createdAt: Date.now(),
//                 lastAccessed: Date.now()
//               };
              
//               // Try to get agent calendar config
//               try {
//                 const calendarConfig = await getAgentCalendarConfig(settings.agentId);
//                 if (calendarConfig) {
//                   settings.calendarConfig = calendarConfig;
//                   settings.systemPrompt = createEnhancedSystemPrompt(
//                     settings.systemPrompt, 
//                     calendarConfig
//                   );
//                   settings.availableFunctions = createAvailableFunctions(calendarConfig);
//                 }
//               } catch (error) {
//                 console.log("No calendar config for inbound call:", error.message);
//               }
              
//               // Pre-fetch knowledge
//               try {
//                 const knowledgeChunks = await preFetchAgentKnowledge(settings.agentId);
//                 settings.knowledgeChunks = knowledgeChunks;
//               } catch (error) {
//                 console.log("Could not pre-fetch knowledge:", error.message);
//               }
              
//               callSettings.set(state.callSid, settings);
//               console.log(`✅ Created inbound call settings for ${state.callSid}, agent: ${settings.agentId}`);
//             }
            
//             // Map inbound call directly
//             streamToCallMap.set(state.streamSid, state.callSid);
//           }

//           const sampleRate = evt.start.media_format?.sample_rate || 8000;
//           // await connectDeepgram(sampleRate);

//           /* 🔥 CRITICAL FIX: START SILENCE IMMEDIATELY 🔥 */
//           if (!silenceTimer) {
//             console.log("🔇 Starting initial silence keepalive");

//           silenceTimer = setInterval(() => {
//   if (
//     exotelWs.readyState === 1 &&
//     state.streamSid &&
//     !state.botSpeaking &&
//     !state.userSpeaking
//   ) {
//     exotelWs.send(JSON.stringify({
//       event: "media",
//       stream_sid: state.streamSid,
//       media: {
//         payload: Buffer.alloc(3200, 0x00).toString("base64")
//       }
//     }));
//   }
// }, 250); // ✅ was 100ms

//           }
          
//           // Send initial greeting only for inbound calls
//           const settings = await getCallSettings(state.streamSid, state.callSid);
//           if (settings) {
//             const isInbound = settings.callType === "inbound" || !settings.elevenLabsVoiceId;
            
//             if (isInbound && settings?.firstMessage) {
//               console.log(`👋 Saying inbound greeting: ${settings.firstMessage}`);
//               setTimeout(async () => {
//                 try {
//                   await speakText(settings.firstMessage, state, exotelWs, {
//                     voiceId: settings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM",
//                     stability: settings.elevenLabsStability ?? 1.0,
//                     similarityBoost: settings.elevenLabsSimilarityBoost ?? 0.8,
//                     speed: settings.elevenLabsSpeed ?? 0.85,
//                     aggressive: true
//                   });
//                 } catch (error) {
//                   console.error("Error sending inbound greeting:", error);
//                 }
//               }, 1500);
//             } else if (settings?.firstMessage) {
//               console.log(`📞 Outbound call started, will speak when user responds`);
//               // Outbound calls wait for user response first
//             }
//           }
          
//           return;
//         }

//         /* ---------- MEDIA ---------- */
//         if (evt.event === "media") {
//           // mark that user audio has started
//           state.hasReceivedUserAudio = true;
//           state.userSpeaking = true;

//           if (deepgramWs?.getReadyState() === 1) {
//             deepgramWs.send(
//               Buffer.from(evt.media.payload, "base64")
//             );
//           }
//           return;
//         }

//         if (evt.event === "media") {
//   state.hasReceivedUserAudio = true;
//  state.userSpeaking = true;
//   // 🔥 CONNECT DEEPGRAM ON FIRST AUDIO
//   if (!deepgramWs) {
//     console.log("🎙️ First inbound audio received — connecting Deepgram");
//     await connectDeepgram(
//       evt.media_format?.sample_rate || 8000
//     );
//   }

//   if (deepgramWs?.getReadyState() === 1) {
//     deepgramWs.send(
//       Buffer.from(evt.media.payload, "base64")
//     );
//   }

//   return;
// }


//         /* ---------- DTMF ---------- */
//         if (evt.event === "dtmf") {
//           console.log(`📞 DTMF: ${evt.dtmf.digit}`);
//           return;
//         }

//         /* ---------- STOP ---------- */
//         if (evt.event === "stop") {
//           cleanup();
//           return;
//         }
//       } catch (err) {
//         console.error("❌ WS message error:", err);
//       }
//     });

//     exotelWs.on("close", () => {
//       console.log("📞 Exotel WS closed");
//       cleanup();
//     });

//     /* -------------------------------------------------- */
//     /* 🧹 CLEANUP                                         */
//     /* -------------------------------------------------- */
//     const cleanup = () => {
//       if (silenceTimer) clearInterval(silenceTimer);

//       if (deepgramWs?.getReadyState() === 1) {
//         try {
//           deepgramWs.send(JSON.stringify({ type: "CloseStream" }))
//         } catch {}
//       }
      
//       // Clean up call settings for inbound calls after they end
//       if (state.callSid && callSettings.has(state.callSid)) {
//         const settings = callSettings.get(state.callSid);
//         if (settings?.callType === "inbound") {
//           setTimeout(() => {
//             if (callSettings.has(state.callSid)) {
//               callSettings.delete(state.callSid);
//               console.log(`🧹 Cleaned up inbound call settings for ${state.callSid}`);
//             }
//           }, 30000); // Clean up after 30 seconds
//         }
//       }
//     };
//   });
// });


// // Add this test endpoint
// fastify.post("/test-audio-format", async (request, reply) => {
//   try {
//     const testText = "Hello, this is a test message.";
    
//     // Test with PCM format
//     const pcmAudio = await ttsManager.generateSpeech(testText, {
//       outputFormat: "pcm_16000"
//     });
    
//     // Test with default format
//     const defaultAudio = await ttsManager.generateSpeech(testText, {});
    
//     // Analyze the first few bytes
//     const pcmFirstBytes = pcmAudio.slice(0, 10);
//     const defaultFirstBytes = defaultAudio.slice(0, 10);
    
//     reply.send({
//       success: true,
//       pcmFormat: {
//         size: pcmAudio.length,
//         firstBytes: Array.from(pcmFirstBytes).map(b => b.toString(16).padStart(2, '0')),
//         isEvenLength: pcmAudio.length % 2 === 0,
//         note: "PCM should be even length (16-bit samples)"
//       },
//       defaultFormat: {
//         size: defaultAudio.length,
//         firstBytes: Array.from(defaultFirstBytes).map(b => b.toString(16).padStart(2, '0')),
//         isEvenLength: defaultAudio.length % 2 === 0,
//         note: "Check if this is MP3 (starts with FFFB or FFF3)"
//       }
//     });
    
//   } catch (error) {
//     console.error("Test error:", error);
//     reply.code(500).send({ error: error.message });
//   }
// });







// // ================================================
// // 🔊 PROPER PCM AUDIO CONVERSION FUNCTIONS
// // ================================================

// // Function to convert 16kHz 16-bit PCM to 8kHz 16-bit PCM
// function convert16kHzPCMTo8kHz(pcm16kBuffer) {
//   // Input: 16kHz, 16-bit PCM (little-endian)
//   // Output: 8kHz, 16-bit PCM (little-endian)
  
//   const inputSamples = new Int16Array(pcm16kBuffer.buffer, pcm16kBuffer.byteOffset, pcm16kBuffer.length / 2);
//   const outputLength = Math.floor(inputSamples.length / 2);
//   const outputSamples = new Int16Array(outputLength);
  
//   // Simple decimation: take every other sample
//   for (let i = 0; i < outputLength; i++) {
//     outputSamples[i] = inputSamples[i * 2];
//   }
  
//   return Buffer.from(outputSamples.buffer);
// }

// async function speakText(text, state, exotelWs, ttsOptions = {}) {
//   if (!exotelWs || exotelWs.readyState !== 1) return;

//   // -------------------------------
//   // 🔁 Queue if already speaking
//   // -------------------------------
//   if (state.botSpeaking) {
//     console.log("⏳ Bot already speaking, queueing (Exotel)");
//     state.audioQueue = state.audioQueue || [];

//     if (state.audioQueue.length < 5) {
//       state.audioQueue.push({ text, ttsOptions });
//     }
//     return;
//   }

//   // -------------------------------
//   // 🎤 Initialize speech
//   // -------------------------------
//   state.botSpeaking = true;
//   state.interrupted = false;

//   try {
//     console.log("🔊 Exotel TTS:", text.substring(0, 50), "...");

//     const language = ttsOptions.language || ttsOptions.transcriberLanguage;

//     // -------------------------------
//     // 🔊 CHOOSE TTS ENGINE
//     // -------------------------------
//     if (useSarvam(language)) {
//       console.log(`🗣️ Using Sarvam TTS for language: ${language}`);
      
//       // ✅ SARVAM STREAMING (like Twilio)
//       await sarvamTTS.generateAndStream(
//         text,
//         {
//           voice: ttsOptions.voice || "anushka",
//           languageCode: language,
//           pitch: ttsOptions.pitch ?? 0.0,
//           pace: ttsOptions.speed || 1.0,
//         },
//         exotelWs,
//         state
//       );

//       // Sarvam handles streaming internally, so we're done here
      
//     } else {
//       console.log(`🗣️ Using ElevenLabs TTS for language: ${language}`);
      
//       // ✅ ELEVENLABS (UNCHANGED - your original code)
//       const audio16k = await ttsManager.generateSpeech(text, {
//         voiceId: ttsOptions.voiceId,
//         outputFormat: "pcm_16000",
//         stability: ttsOptions.stability ?? 1.0,
//         similarityBoost: ttsOptions.similarityBoost ?? 0.8,
//         speed: ttsOptions.speed || 1.0,
//         aggressive: ttsOptions.aggressive || true
//       });

//       // 🛑 Check interruption after generation
//       if (state.interrupted || !state.botSpeaking) {
//         console.log("🛑 Interrupted during TTS generation (Exotel)");
//         return;
//       }

//       if (!audio16k || audio16k.length === 0) {
//         console.error("❌ Empty TTS audio");
//         return;
//       }

//       // Convert 16kHz → 8kHz PCM
//       const pcm8k = convert16kHzPCMTo8kHz(audio16k);

//       // Send chunks to Exotel
//       const CHUNK_SIZE = 3200; // 100ms frames for 8kHz

//       for (let i = 0; i < pcm8k.length; i += CHUNK_SIZE) {
//         // Check interruption before each chunk
//         if (state.interrupted || !state.botSpeaking) {
//           console.log(`🛑 Interrupted at chunk ${i}/${pcm8k.length}`);
//           sendClearEvent(exotelWs, state.streamSid);
//           break;
//         }

//         const chunk = pcm8k.slice(i, i + CHUNK_SIZE);
        
//         // Pad last chunk if needed
//         const padded = chunk.length < CHUNK_SIZE
//           ? Buffer.concat([chunk, Buffer.alloc(CHUNK_SIZE - chunk.length)])
//           : chunk;

//         exotelWs.send(JSON.stringify({
//           event: "media",
//           stream_sid: state.streamSid,
//           media: { payload: padded.toString("base64") }
//         }));

//         // 100ms pacing (IMPORTANT)
//         await sleep(100);
//       }
//     }

//     // -------------------------------
//     // 📝 Save transcript only if clean
//     // -------------------------------
//     if (!state.interrupted && state.botSpeaking) {
//       state.fullTranscript.push({
//         role: "bot",
//         text,
//         timestamp: Date.now() - state.sessionStartTime
//       });
//     }

//   } catch (err) {
//     console.error("❌ Exotel speakText error:", err.message);
//   } finally {
//     // -------------------------------
//     // 🧹 Cleanup
//     // -------------------------------
//     state.botSpeaking = false;
//     state.activeTTSAbort = null;

//     // -------------------------------
//     // ▶️ Play queued message
//     // -------------------------------
//     if (state.audioQueue?.length > 0 && !state.interrupted) {
//       const next = state.audioQueue.shift();
//       setTimeout(() => {
//         speakText(next.text, state, exotelWs, next.ttsOptions);
//       }, 80);
//     }

//     // Reset interrupt AFTER audio stops
//     setTimeout(() => {
//       state.interrupted = false;
//     }, 50);
//   }
// }

// function sendClearEvent(exotelWs, streamSid) {
//   if (exotelWs && exotelWs.readyState === 1 && streamSid) {
//     console.log("🧹 Sending clear event to Exotel");
    
//     try {
//       // ✅ SEND CLEAR EVENT
//       exotelWs.send(
//         JSON.stringify({
//           event: "clear",
//           stream_sid: streamSid
//         })
//       );
      
//       // ✅ SEND A SMALL SILENCE BUFFER TO CLEAR THE LINE
//       exotelWs.send(
//         JSON.stringify({
//           event: "media",
//           stream_sid: streamSid,
//           media: {
//             payload: ""
//           }
//         })
//       );
      
//       console.log("✅ Clear event and silence buffer sent");
//     } catch (error) {
//       console.error("❌ Error sending clear event:", error);
//     }
//   }
// }
// /* -------------------------------------------------------------------------- */
// /* ✅ /end-call-exotel — End Exotel Call                                      */
// /* -------------------------------------------------------------------------- */
// fastify.post("/end-call-exotel/:callSid", async (request, reply) => {
//   const { callSid } = request.params;
//   const settings = callSettings.get(callSid);
  
//   if (!settings) {
//     return reply.code(404).send({ error: "Call not found" });
//   }
  
//   try {
//     // Note: Exotel doesn't have a direct "end call" API like Twilio
//     // The call ends when the WebSocket connection closes
    
//     console.log(`📞 Exotel call ${callSid} marked for ending`);
    
//     // Clean up local state
//     callSettings.delete(callSid);
//     sessions.delete(callSid);
    
//     // Remove from streamToCallMap
//     for (const [streamSid, mappedCallSid] of streamToCallMap.entries()) {
//       if (mappedCallSid === callSid) {
//         streamToCallMap.delete(streamSid);
//         break;
//       }
//     }
    
//     reply.send({ 
//       success: true, 
//       message: "Call cleanup completed",
//       note: "Exotel calls end when WebSocket connection closes automatically"
//     });
    
//   } catch (err) {
//     console.error("❌ Failed to end Exotel call:", err);
//     reply.code(500).send({ error: "Failed to end call", details: err.message });
//   }
// });

// /* -------------------------------------------------------------------------- */
// /* ✅ KEEP EXISTING ENDPOINTS (unchanged)                                     */
// /* -------------------------------------------------------------------------- */

// // Keep your existing preview-agent endpoints (they don't involve Twilio/Exotel)


// // fastify.register(workflowRoutes, { prefix: '/api' });

// // Keep your existing WebSocket endpoints for non-Exotel use

// fastify.register(async function (fastify) {
//   fastify.get("/ws-preview", { websocket: true }, (ws, req) => {
//     const callSid = req.query.callSid;
//     const settings = callSettings.get(callSid);
//     if (!settings) {
//       console.error("❌ Unknown callSid in WebSocket:", callSid);
//       ws.close();
//       return;
//     }
//     ws.on("message", async (data) => {
//       const message = JSON.parse(data);
//       switch (message.type) {
//         case "setup":
//           console.log("⚙️ Setup received for CallSid:", callSid);
//           ws.callSid = callSid;
//           sessions.set(callSid, []);
//           break;
//         case 'prompt':
//           console.log('🎤 Prompt:', message.voicePrompt);
//           const conversation = sessions.get(callSid) || [];
//           conversation.push({ role: 'user', content: message.voicePrompt });
//           const { workflow, currentNodeId, knowledgeChunks } = settings;
//           const currentNode = workflow?.nodes?.find(n => n.id === currentNodeId);
//           if (currentNode?.type === 'end_call') {
//             console.log('🛑 End call node reached');
//             const nodeConfig = typeof currentNode.config === 'string'
//               ? JSON.parse(currentNode.config)
//               : currentNode.config;
//             if (nodeConfig.actions) {
//               await executeNodeActions(nodeConfig.actions, settings.extractedVariables, callSid);
//             }
//             const endMessage = nodeConfig.prompt || 'Thank you for your time. Goodbye!';
//             try {
//               const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
//               await client.calls(callSid).update({ status: 'completed' });
//               console.log(`📞 Call ${callSid} ended via Twilio API`);
//             } catch (err) {
//               console.error("❌ Failed to end call via Twilio API:", err);
//             }
//             setTimeout(() => {
//               ws.close();
//               callSettings.delete(callSid);
//               sessions.delete(callSid);
//             }, 3000);
//             return;
//           }
//           const topChunk = settings.knowledgeChunks?.[0]?.content || '';
//           console.log('📌 Pre-fetched knowledge chunks used');
//           let dynamicPrompt = settings.systemPrompt;
//           if (currentNode) {
//             const nodeConfig = typeof currentNode.config === 'string'
//               ? JSON.parse(currentNode.config)
//               : currentNode.config;
//             dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
//             if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
//             if (Object.keys(settings.extractedVariables).length > 0) {
//               dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(settings.extractedVariables)}`;
//             }
//           }
//           dynamicPrompt += '\n\nContext:\n' + topChunk;
//           const messages = [
//             { role: "system", content: dynamicPrompt },
//             ...conversation,
//           ];
//           // 🔧 FIX: Use function calling if calendar is configured
//           let response = '';
//           if (settings.calendarConfig && settings.availableFunctions) {
//             console.log('📞 Using function calling for meeting scheduling');
//             const aiMessage = await aiResponseWithFunctions(
//               messages,
//               settings.aiModel,
//               settings.temperature,
//               settings.maxTokens,
//               settings.availableFunctions
//             );

//             // Check if AI wants to call a function
//             if (aiMessage.function_call) {
//               console.log('🔧 Function call detected:', aiMessage.function_call.name);

//               try {
//                 const functionName = aiMessage.function_call.name;
//                 const functionArgs = JSON.parse(aiMessage.function_call.arguments);

//                 let functionResult;
//                 switch (functionName) {
//                   case 'schedule_meeting':
//                     console.log('📅 Scheduling meeting with args:', functionArgs);
//                     functionResult = await handleScheduleMeeting(functionArgs, callSid, settings);
//                     break;

//                   case 'question_and_answer':
//                     console.log('❓ Answering question:', functionArgs.query);
//                     functionResult = await handleQuestionAnswer(functionArgs.query, settings);
//                     break;

//                   case 'hangUp':
//                     console.log('📞 Hanging up call:', functionArgs.reason);
//                     functionResult = await handleHangUp(functionArgs.reason, callSid);
//                     break;

//                   default:
//                     console.warn('⚠️ Unknown function:', functionName);
//                     functionResult = { error: `Unknown function: ${functionName}` };
//                 }

//                 // Send function result back to customer
//                 response = functionResult.message || functionResult.answer || 'Function executed successfully.';
//                 ws.send(JSON.stringify({ type: "text", token: response, last: true }));

//                 // If it was a hangup, close the connection
//                 if (functionName === 'hangUp') {
//                   ws.close();
//                   return;
//                 }

//               } catch (error) {
//                 console.error('❌ Error executing function:', error);
//                 response = "I apologize, but I encountered an error. Could you please try again?";
//                 ws.send(JSON.stringify({ type: "text", token: response, last: true }));
//               }
//             } else if (aiMessage.content) {
//               // No function call, but we have content - stream it
//               response = aiMessage.content;
//               ws.send(JSON.stringify({ type: "text", token: response, last: true }));
//             } else {
//               // Fallback to regular streaming response
//               response = await aiResponse(
//                 ws,
//                 messages,
//                 settings.aiModel,
//                 settings.temperature,
//                 settings.maxTokens
//               );
//             }
//           } else {
//             // Fallback to regular streaming response if no calendar configured
//             console.log('📞 Using regular response (no calendar configured)');
//             response = await aiResponse(
//               ws,
//               messages,
//               settings.aiModel,
//               settings.temperature,
//               settings.maxTokens
//             );
//           }

//           console.log("🤖 AI processing completed:", response);
//           if (currentNode?.config?.variableExtractionPlan) {
//             const newVariables = await extractVariables(
//               message.voicePrompt,
//               currentNode.config.variableExtractionPlan
//             );
//             settings.extractedVariables = {
//               ...settings.extractedVariables,
//               ...newVariables
//             };
//             console.log('📝 Extracted variables:', newVariables);
//           }
//           if (workflow && currentNodeId) {
//             const nextNodeId = determineNextNode(workflow, currentNodeId, response, message.voicePrompt);
//             if (nextNodeId) {
//               settings.currentNodeId = nextNodeId;
//               console.log('⏭️ Moving to next node:', nextNodeId);
//             }
//           }
//           conversation.push({ role: "assistant", content: response });
//           break;
//         case "interrupt":
//           console.log("🔕 Interrupt received.");
//           break;
//         default:
//           console.warn("⚠️ Unknown message type:", message.type);
//       }
//     });
//     ws.on("close", () => {
//       console.log("🛑 WebSocket closed");
//       sessions.delete(callSid);
//       callSettings.delete(callSid);
//     });
//   });
// });



// /* -------------------------------------------------------------------------- */
// /* ✅ START SERVER                                                            */
// /* -------------------------------------------------------------------------- */
// }







import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import Twilio from "twilio";
import OpenAI from "openai";
import cors from "@fastify/cors";
import fs from 'fs';
import dotenv from "dotenv";
dotenv.config({ path: ".env.production" });
import { SarvamAIClient } from "sarvamai";
import workflowRoutes from '../routes/workflowRoutes.js';
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
import db from '../db.js';


const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
let sarvamReady = false;
const audioBufferQueue = [];


const fastify = Fastify({
  logger: true,
  maxParamLength: 1024,
  requestTimeout: 10000,
  keepAliveTimeout: 65 * 1000,
});
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
});
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);
await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const sessions = new Map();
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

async function loadInboundSettings(phoneNumber) {
  try {
    console.log(`🔍 Loading inbound settings for phone: ${phoneNumber}`);
    
    // Fetch inbound configuration from database
    const result = await db.query(
      `SELECT ic.*, a.name as agent_name, a.system_prompt, a.ai_model, a.temperature,
              a.voice_id, a.voice_provider, a.first_message
       FROM inbound_configs ic
       LEFT JOIN agents a ON ic.agent_id = a.id
       WHERE ic.phone_number = $1`,
      [phoneNumber]
    );
    
    if (result.rows.length === 0) {
      console.log(`⚠️ No inbound config found for ${phoneNumber}`);
      return null;
    }
    
    const config = result.rows[0];
    console.log(`✅ Found config for ${config.phone_number}, agent: ${config.agent_name || config.agent_id}`);
    
    // Fetch agent knowledge and calendar config
    const [calendarConfig, knowledgeChunks] = await Promise.all([
      getAgentCalendarConfig(config.agent_id),
      preFetchAgentKnowledge(config.agent_id),
    ]);
    
    return {
      agentId: config.agent_id,
      agentName: config.agent_name || 'Inbound Agent',
      agentEmail: calendarConfig?.calendar_email,
      aiModel: config.ai_model || "gpt-4o-mini",
      temperature: parseFloat(config.temperature) || 0.7,
      maxTokens: 180,
      systemPrompt: config.system_prompt || 
                   `You are ${config.agent_name || "a helpful assistant"}.`,
      firstMessage: config.greeting_message || 
                   config.first_message || 
                   "Hello! How can I help you today?",
      knowledgeChunks: knowledgeChunks || [],
      calendarConfig: calendarConfig || null,
      sarvamVoice: config.voice || "karun",
      sarvamLanguage: "hi-IN",
      transcriberProvider: "sarvam",
      transcriberLanguage: config.transcriber_language || "en",
      transcriberModel: "saarika:v2.5",
      isInbound: true
    };
    
  } catch (error) {
    console.error("❌ Error loading inbound settings:", error);
    console.error("Stack trace:", error.stack);
    return null;
  }
}

class SarvamTTS {
  constructor(apiKey) {
    if (!apiKey) throw new Error("SARVAM_API_KEY missing");
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.model = "bulbul:v2";
  }

async generateAndStream(text, options = {}, twilioWs, state) {
  if (!text?.trim()) return;
  const voice = options.voice || "karun";  // ✅ Getting voice from options
  const pitch = options.pitch ?? 0.0;
  const pace = options.pace ?? 1.0;
  const socket = await this.client.textToSpeechStreaming.connect({
    model: this.model,
    send_completion_event: true,
  });
  await socket.waitForOpen();
  // ✅ Use the voice variable, not hard-coded "karun"
  socket.configureConnection({
    type: "config",
    data: {
      target_language_code: "kn-IN",
      speaker: voice,  // ✅ Use the voice parameter here
      pitch: pitch,    // ✅ Use the pitch parameter
      pace: pace,      // ✅ Use the pace parameter
      output_audio_codec: "mulaw",
      speech_sample_rate: "8000",
      min_buffer_size: 50,
      max_chunk_length: 150
    }
  });

   let buffer = Buffer.alloc(0);

socket.on("message", async (msg) => {
  if (
    msg.type === "audio" &&
    msg.data?.audio &&
    twilioWs.readyState === WebSocket.OPEN &&
    !state.interrupted &&
    !state.callEnded
  ) {
    try {
      // 1️⃣ MP3 → PCM
      const pcm = await mp3Base64ToPcm(msg.data.audio);

      // 2️⃣ PCM → μ-law
      const mulaw = linear16ToMulaw(pcm);

      // 3️⃣ Send to Twilio
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: state.streamSid,
        media: {
          track: "outbound",
          payload: mulaw.toString("base64")
        }
      }));
    } catch (e) {
      console.error("[TTS CONVERT ERROR]", e);
    }
  }
});



    socket.on("error", (err) => {
      console.error("[TTS] Socket error:", err);
    });

    socket.convert(text.trim());
    socket.flush();
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
    twilioWs.send(JSON.stringify({
      event: "clear",
      streamSid: streamSid
    }));

    // Empty media packet helps Twilio flush faster
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid: streamSid,
      media: { payload: "" }
    }));

    console.log("[CLEAR] Sent clear command to Twilio");
  } catch (err) {
    console.error("[clearEvent] Error sending clear:", err);
  }
}




class SarvamSTT {
  constructor() {
    this.socket = null;
    this.onTranscript = null;
    this.onError = null;
    this.language = 'kn-IN';
    this.client = new SarvamAIClient({
      apiSubscriptionKey: process.env.SARVAM_API_KEY
    });
    this.isConnected = false;
    this.connectionPromise = null;
    this.pendingAudio = [];           // Buffer until connected
    this.maxReconnectAttempts = 5;
    this.reconnectAttempts = 0;
  }

  async connect(language = 'kn-IN') {
    if (this.connectionPromise) {
      console.log("[SarvamSTT] Already connecting — reusing promise");
      return this.connectionPromise;
    }

    this.language = language;
    this.isConnected = false;
    this.reconnectAttempts = 0;

    this.connectionPromise = this._connectWithRetry(language);
    return this.connectionPromise;
  }

  async _connectWithRetry(language, attempt = 1) {
    try {
      console.log(`[SarvamSTT] Connecting (attempt ${attempt}/${this.maxReconnectAttempts}) — lang: ${language}`);

      if (!process.env.SARVAM_API_KEY) {
        throw new Error("SARVAM_API_KEY missing!");
      }

      console.log(`[SarvamSTT] API Key prefix: ${process.env.SARVAM_API_KEY.substring(0, 8)}...`);

      this.socket = await this.client.speechToTextStreaming.connect({
        "language-code": language,
        model: "saarika:v2.5",              // ← from docs (latest stable)
        sample_rate: 8000,
        input_audio_codec: "pcm_s16le",     // ← important: tell Sarvam we send raw PCM
        high_vad_sensitivity: "true",      // ← start conservative (less strict)
        vad_signals: "true"
      });

      console.log("[SarvamSTT] Socket created — waiting for open...");

      this.socket.on("open", () => {
        console.log(`[SarvamSTT] === OPEN SUCCESS === lang: ${language}`);
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Flush pending raw PCM chunks
        if (this.pendingAudio.length > 0) {
          console.log(`[SarvamSTT] Flushing ${this.pendingAudio.length} pending raw PCM chunks`);
          this.pendingAudio.forEach(buf => this._sendAudioInternal(buf));
          this.pendingAudio = [];
        }
      });

      this.socket.on("message", (response) => {
        console.log("[Sarvam DEBUG] Raw message:", JSON.stringify(response, null, 2));
        this._handleMessage(response);
      });

      this.socket.on("error", (err) => {
        console.error("[SarvamSTT] WS ERROR:", err.message || err);
        this.isConnected = false;
        if (this.onError) this.onError(err);
      });

      this.socket.on("close", (code, reason) => {
        console.log(`[SarvamSTT] WS CLOSED — code: ${code}, reason: ${reason || 'none'}`);
        this.isConnected = false;
        this.connectionPromise = null;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = 1500 * this.reconnectAttempts;
          console.log(`[SarvamSTT] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this.connect(language).catch(console.error), delay);
        }
      });

      await Promise.race([
        this.socket.waitForOpen(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("waitForOpen timeout")), 12000))
      ]);

      console.log("[SarvamSTT] Connection fully ready ✓");
      return true;

    } catch (err) {
      console.error(`[SarvamSTT] Connect failed (attempt ${attempt}):`, err.message);
      console.error(err.stack || err);

      if (attempt < this.maxReconnectAttempts) {
        const delay = 2000 * attempt;
        console.log(`[SarvamSTT] Retry in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this._connectWithRetry(language, attempt + 1);
      }
      throw err;
    }
  }

_handleMessage(response) {
  try {
    if (response.type === 'events') {
      const signal = response.data?.signal_type;
      if (signal === 'START_SPEECH') console.log('[Sarvam] START_SPEECH');
      if (signal === 'END_SPEECH')   console.log('[Sarvam] END_SPEECH');
    }

    if (response.type === 'data') {
      const text = (response.data?.transcript || '').trim();
      const lang = response.data?.language_code;
      const duration = response.data?.metrics?.audio_duration;

      if (text) {
        console.log(`[Sarvam] Transcript (${duration?.toFixed(2)}s, ${lang}): "${text}"`);
        if (this.onTranscript) {
          this.onTranscript(text, true);  // treat all as final for now
        }
      } else {
        console.log('[Sarvam] Empty transcript (silence or noise)');
      }
    }
  } catch (e) {
    console.error("[Sarvam] Parse error:", e);
  }
}

  sendAudio(buffer) {
    if (!buffer || buffer.length === 0) return;

    if (this.isConnected && this.socket) {
      this._sendAudioInternal(buffer);
    } else {
      this.pendingAudio.push(buffer);
      if (this.pendingAudio.length > 60) { // ~10–12 seconds buffer
        console.warn("[SarvamSTT] Buffer full — dropping oldest chunk");
        this.pendingAudio.shift();
      }
      console.log(`[SarvamSTT] Buffered ${buffer.length} bytes PCM — queue: ${this.pendingAudio.length}`);
    }
  }

_sendAudioInternal(rawPcmBuffer) {
  try {
    if (!this.socket || !this.isConnected) {
      console.warn("[SarvamSTT] Cannot send — not connected");
      return;
    }

    // ────────────────────────────────────────────────
    // Normalize volume (peak normalization — much more reliable)
    // ────────────────────────────────────────────────
    const inView = new Int16Array(rawPcmBuffer.buffer);
    let maxAbs = 0;
    for (let i = 0; i < inView.length; i++) {
      const abs = Math.abs(inView[i]);
      if (abs > maxAbs) maxAbs = abs;
    }

    const amplified = Buffer.alloc(rawPcmBuffer.length);
    const outView = new Int16Array(amplified.buffer);

    if (maxAbs > 200) {  // avoid boosting pure silence/noise
      const targetPeak = 30000;  // ~91–92% of full scale → safe headroom
      const scale = targetPeak / maxAbs;

      for (let i = 0; i < inView.length; i++) {
        let sample = inView[i] * scale;
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        outView[i] = Math.round(sample);
      }

      const postMax = Math.max(...outView.map(Math.abs));
      const peakDbBefore = maxAbs > 0 ? 20 * Math.log10(maxAbs / 32768) : -Infinity;
      const peakDbAfter  = postMax  > 0 ? 20 * Math.log10(postMax  / 32768) : -Infinity;
     // console.log(`[AUDIO] orig peak ${peakDbBefore.toFixed(1)} dBFS → after norm ${peakDbAfter.toFixed(1)} dBFS (scale ${scale.toFixed(2)})`);
    } else {
     // console.log("[AUDIO] Very quiet chunk — copying without boost");
      rawPcmBuffer.copy(amplified);
    }

    // ────────────────────────────────────────────────
    // Create WAV header — IMPORTANT: use 8000 Hz everywhere
    // ────────────────────────────────────────────────
    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0, 4, 'ascii');
    wavHeader.writeUInt32LE(36 + amplified.length, 4);
    wavHeader.write('WAVE', 8, 4, 'ascii');
    wavHeader.write('fmt ', 12, 4, 'ascii');
    wavHeader.writeUInt32LE(16, 16);                // fmt chunk size
    wavHeader.writeUInt16LE(1, 20);                 // PCM = 1
    wavHeader.writeUInt16LE(1, 22);                 // mono = 1 channel
    wavHeader.writeUInt32LE(8000, 24);              // ← SAMPLE RATE = 8000 Hz !!!
    wavHeader.writeUInt32LE(8000 * 2, 28);          // byte rate = sampleRate × channels × bits/8
    wavHeader.writeUInt16LE(2, 32);                 // block align = channels × bits/8
    wavHeader.writeUInt16LE(16, 34);                // bits per sample
    wavHeader.write('data', 36, 4, 'ascii');
    wavHeader.writeUInt32LE(amplified.length, 40);

    const fullWav = Buffer.concat([wavHeader, amplified]);
    const base64Audio = fullWav.toString('base64');

    // Send to Sarvam — must match the header!
    this.socket.transcribe({
      audio: base64Audio,
      sample_rate: 8000,           // ← must be 8000
      encoding: "audio/wav"
    });

    //console.log(`[SarvamSTT] Sent 8000 Hz WAV — ${fullWav.length} bytes (${base64Audio.length} b64 chars)`);
  } catch (err) {
    console.error("[SarvamSTT] Send failed:", err.message);
    this.isConnected = false;
  }
}

  close() {
    console.log("[SarvamSTT] Closing...");
    this.isConnected = false;
    this.connectionPromise = null;
    this.pendingAudio = [];

    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
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


async function getRelevantChunks(query, agentId, topK = 2) {
  try {
    const queryEmbedding = await embedText(query);
    const results = await index.query({
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true,
      filter: { agent_id: agentId },
    });
    return results.matches.map(match => match.metadata.content);
  } catch (error) {
    console.error('Error getting relevant chunks:', error);
    return [];
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

const callSettings = new Map();
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


  const streamToCallMap = new Map(); // 🔧 NEW: streamSid → callSid

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
  
  // Check if this is an inbound call
  if (callSid.startsWith('inbound_')) {
    console.log(`📥 Inbound call detected: ${callSid}`);
    
    // For inbound calls, we need to fetch settings from database
    // Extract phone number from the key (format: inbound_+16292587397_timestamp)
    const phoneNumber = callSid.split('_')[1];
    
    try {
      // Fetch inbound configuration from database
      const result = await db.query(
        `SELECT ic.*, a.name as agent_name, a.system_prompt, a.ai_model, a.temperature,
                a.voice_id, a.voice_provider, a.first_message
         FROM inbound_configs ic
         LEFT JOIN agents a ON ic.agent_id = a.id
         WHERE ic.phone_number = $1`,
        [phoneNumber]
      );
      
      if (result.rows.length === 0) {
        console.log(`⚠️ No inbound config found for ${phoneNumber}`);
        return null;
      }
      
      const config = result.rows[0];
      console.log(`✅ Loaded inbound config for ${config.phone_number}, agent: ${config.agent_name}`);
      
      // Fetch agent knowledge and calendar config
      const [calendarConfig, knowledgeChunks] = await Promise.all([
        getAgentCalendarConfig(config.agent_id),
        preFetchAgentKnowledge(config.agent_id),
      ]);
      
      const settings = {
        agentId: config.agent_id,
        agentName: config.agent_name,
        agentEmail: calendarConfig?.calendar_email,
        aiModel: config.ai_model || "gpt-4o-mini",
        temperature: parseFloat(config.temperature) || 0.7,
        maxTokens: 180,
        systemPrompt: config.system_prompt || 
                     `You are ${config.agent_name || "a helpful assistant"}.`,
        firstMessage: config.greeting_message || 
                     config.first_message || 
                     "Hello! How can I help you today?",
        knowledgeChunks,
        calendarConfig,
        sarvamVoice: config.voice || "karun",
        sarvamLanguage: "hi-IN",
        transcriberProvider: "sarvam",
        transcriberLanguage: "en",
        transcriberModel: "saarika:v2.5",
        isInbound: true // Mark as inbound
      };
      
      // Store in callSettings map
      callSettings.set(streamSid, settings);
      console.log(`💾 Inbound settings saved for streamSid: ${streamSid}`);
      
      return settings;
      
    } catch (error) {
      console.error("Error loading inbound settings:", error);
      return null;
    }
  }
  
  // Outbound call - use existing logic
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
    sarvamVoice = "karun",
    sarvamLanguage = "hi-IN",
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
      systemPrompt: enhancedSystemPrompt,
      firstMessage,
      maxTokens: parseInt(maxTokens, 10),
      calendarConfig: calendarConfig || null,
      knowledgeChunks,
      // Sarvam TTS settings
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
  f.get("/ws-direct", { websocket: true }, async (twilioWs, req) => {
    console.log("\n🌐 Twilio WebSocket connected (/ws-direct)");
    
    // DEBUG: Log the raw URL
    console.log(`🔗 Raw URL: ${req.url}`);
    
    // Parse query parameters manually
    let params = {};
    try {
      const urlParts = req.url.split('?');
      if (urlParts.length > 1) {
        const queryString = urlParts[1];
        const searchParams = new URLSearchParams(queryString);
        params = Object.fromEntries(searchParams.entries());
      }
    } catch (error) {
      console.error("Error parsing query parameters:", error);
    }
    
    console.log(`🔍 Parsed query params:`, params);
    
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
      
      // INBOUND SPECIFIC FIELDS - set from query params immediately
      isInbound: params.inbound === 'true',
      inboundPhoneNumber: params.phoneNumber || null,
      inboundAgentId: params.agentId || null,
      inboundConfig: null,
      inboundCallSid: null,

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

    console.log(`📞 Initial state: isInbound=${state.isInbound}, phone=${state.inboundPhoneNumber}, agent=${state.inboundAgentId}`);

    // =========================================================================
    // SIMPLIFIED: Get settings for inbound calls
    // =========================================================================
    
    const getInboundCallSettings = async () => {
      if (!state.inboundPhoneNumber) {
        console.log("⚠️ Cannot get inbound settings: no phone number");
        return null;
      }
      
      try {
        console.log(`🔍 Fetching agent config for phone: ${state.inboundPhoneNumber}`);
        
        // Fetch inbound configuration from database
        const result = await db.query(
          `SELECT ic.*, a.name as agent_name, a.system_prompt, a.ai_model, a.temperature,
                  a.voice_id, a.voice_provider, a.first_message, a.config
           FROM inbound_configs ic
           LEFT JOIN agents a ON ic.agent_id = a.id
           WHERE ic.phone_number = $1`,
          [state.inboundPhoneNumber]
        );
        
        if (result.rows.length === 0) {
          console.log(`⚠️ No inbound config found for ${state.inboundPhoneNumber}`);
          return null;
        }
        
        const config = result.rows[0];
        console.log(`✅ Found agent config: ${config.agent_name} (ID: ${config.agent_id})`);
        
        // Parse agent config JSON
        let agentConfig = {};
        try {
          if (config.config) {
            agentConfig = typeof config.config === 'string' ? JSON.parse(config.config) : config.config;
          }
        } catch (e) {
          console.error("Error parsing agent config:", e);
        }
        
        // Get agent settings from config
        const agentSettings = agentConfig.agent || {};
        const promptSettings = agentSettings.prompt || {};
        const ttsSettings = agentConfig.tts || {};
        
        // Fetch agent knowledge and calendar config
        const [calendarConfig, knowledgeChunks] = await Promise.all([
          getAgentCalendarConfig(config.agent_id),
          preFetchAgentKnowledge(config.agent_id),
        ]);
        
        const settings = {
          agentId: config.agent_id,
          agentName: config.agent_name || "Inbound Agent",
          agentEmail: calendarConfig?.calendar_email,
          aiModel: promptSettings.llm || config.ai_model || "gpt-4o-mini",
          temperature: parseFloat(promptSettings.temperature || config.temperature || 0.7),
          maxTokens: parseInt(promptSettings.max_tokens || 180, 10),
          systemPrompt: config.system_prompt || promptSettings.prompt || 
                       `You are ${config.agent_name || "a helpful assistant"}.`,
          firstMessage: config.greeting_message || 
                       config.first_message || 
                       "Hello! How can I help you today?",
          knowledgeChunks: knowledgeChunks || [],
          calendarConfig,
          sarvamVoice: config.voice || "karun",
          sarvamLanguage: "hi-IN",
          transcriberProvider: "sarvam",
          transcriberLanguage: agentConfig.language || "en",
          transcriberModel: "saarika:v2.5",
          isInbound: true
        };
        
        // Store in callSettings map using streamSid as key
        if (state.streamSid) {
          callSettings.set(state.streamSid, settings);
          console.log(`💾 Inbound settings saved for streamSid: ${state.streamSid}`);
        }
        
        return settings;
        
      } catch (error) {
        console.error("❌ Error loading inbound settings:", error);
        console.error("Stack trace:", error.stack);
        return null;
      }
    };

    // =========================================================================
    // MODIFIED: Main Twilio WebSocket message handler
    // =========================================================================
    
    twilioWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        if (evt.event === "start") {
          state.streamSid = evt.start.streamSid;
          const twilioCallSid = evt.start.callSid;
          
          console.log(`📞 Stream started: ${state.streamSid}`);
          console.log(`📱 isInbound: ${state.isInbound}, phone: ${state.inboundPhoneNumber}`);
          
          // Set inbound call details if available
          if (state.isInbound && state.inboundPhoneNumber) {
            console.log(`📥 INBOUND call detected on ${state.inboundPhoneNumber}`);
            state.inboundCallSid = twilioCallSid;
            
            // Store mapping for inbound call
            streamToCallMap.set(state.streamSid, state.inboundPhoneNumber);
            console.log(`🔗 Mapped ${state.streamSid} → ${state.inboundPhoneNumber} (inbound)`);
            
            // Log inbound call for tracking
            try {
              await db.query(
                `INSERT INTO call_logs 
                 (call_sid, direction, to_number, status, created_at)
                 VALUES ($1, 'inbound', $2, 'active', CURRENT_TIMESTAMP)
                 ON CONFLICT (call_sid) 
                 DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
                [twilioCallSid, state.inboundPhoneNumber]
              );
            } catch (dbError) {
              console.error("Error logging inbound call:", dbError);
            }
          } else {
            // Outbound call
            console.log(`📤 OUTBOUND call detected`);
            if (twilioCallSid) {
              streamToCallMap.set(state.streamSid, twilioCallSid);
              console.log(`🔗 Mapped ${state.streamSid} → ${twilioCallSid} (outbound)`);
            }
          }

          console.log(`🚀 Starting call as: ${state.isInbound ? 'INBOUND' : 'OUTBOUND'}`);

          // Connect Sarvam STT
          const connectSarvam = async () => {
            if (!state.streamSid) {
              console.error("Cannot connect Sarvam: streamSid missing");
              return;
            }

            console.log(`🔗 Connecting Sarvam for ${state.isInbound ? 'INBOUND' : 'OUTBOUND'} call`);
            
            // Get settings based on call type
            let settings;
            
            if (state.isInbound) {
              console.log(`📥 Loading inbound settings for ${state.inboundPhoneNumber}`);
              settings = await getInboundCallSettings();
            } else {
              console.log(`📤 Loading outbound settings for ${state.streamSid}`);
              settings = await getCallSettings(state.streamSid);
            }
            
            if (!settings) {
              console.error("❌ No settings found for Sarvam");
              
              // For inbound calls, try to create default settings
              if (state.isInbound && state.inboundPhoneNumber) {
                console.log("🔄 Creating default settings for inbound call");
                settings = {
                  agentId: state.inboundAgentId || 'default-agent',
                  agentName: "Inbound Agent",
                  aiModel: "gpt-4o-mini",
                  temperature: 0.7,
                  maxTokens: 180,
                  systemPrompt: "You are a helpful assistant answering inbound calls.",
                  firstMessage: "Hello! How can I help you today?",
                  knowledgeChunks: [],
                  calendarConfig: null,
                  sarvamVoice: "karun",
                  sarvamLanguage: "hi-IN",
                  transcriberProvider: "sarvam",
                  transcriberLanguage: "en",
                  transcriberModel: "saarika:v2.5",
                  isInbound: true
                };
                
                // Store in callSettings
                callSettings.set(state.streamSid, settings);
                console.log(`💾 Created default settings for inbound call`);
              } else {
                console.error("❌❌ Could not create settings for this call");
                return;
              }
            }

            console.log(`✅ Settings loaded: ${settings.agentName || 'Unknown Agent'}`);

            const languageMap = {
              'en': 'en-IN',
              'hi': 'hi-IN',
              'kn': 'kn-IN',
              'ta': 'ta-IN',
              'te': 'te-IN',
              'mr': 'mr-IN',
            };

            const lang = languageMap[settings.transcriberLanguage?.split('-')[0]] || 'kn-IN';

            // Clean up old connection if exists
            if (state.stt) {
              state.stt.close();
            }

            state.stt = new SarvamSTT();

            try {
              console.log(`🚀 Connecting Sarvam STT (lang: ${lang})...`);
              await state.stt.connect(lang);
              console.log(`✅ Sarvam STT ready for audio`);
            } catch (error) {
              console.error(`❌ Failed to connect Sarvam STT:`, error);
              return;
            }

            // Set up STT callbacks
            state.stt.onTranscript = (text, isFinal) => {
              if (!text?.trim()) return;

              const transcript = text.trim();

              // Handle interim transcripts (optional)
              if (!isFinal) {
                state.currentTranscript = transcript;
                return;
              }

              // Filter out very short / filler-only final transcripts
              const words = transcript.split(/\s+/).filter(Boolean);
              const isVeryShort = transcript.length < 6 || words.length <= 1;
              const isFillerOnly =
                ['ok', 'okay', 'yeah', 'yes', 'no', 'uh', 'um', 'hmm', 'right', 'sure', 'got it', 'mhm'].includes(
                  transcript.toLowerCase()
                ) ||
                transcript.match(/^(uh+|um+|mm+|yeah+|ok+|mhm+)\s*$/i);

              if (isVeryShort || isFillerOnly) {
                console.log(`[TURN-SKIP] Ignored short/filler: "${transcript}" (${words.length} words)`);
                if (!state.botSpeaking && Date.now() - (state.lastBotSpeechEnd || 0) > 12000) {
                  speakText("Got it...", state, twilioWs, { pace: 1.1 });
                }
                return;
              }

              // Wait for silence before accepting turn
              state.pendingUserText = transcript;
              state.lastSpeechEndTime = Date.now();

              if (state.turnDecisionTimeout) {
                clearTimeout(state.turnDecisionTimeout);
              }

              state.turnDecisionTimeout = setTimeout(() => {
                const now = Date.now();
                const silenceMs = now - state.lastSpeechEndTime;

                if (silenceMs >= 1000 && state.pendingUserText) {
                  console.log(`[TURN-ACCEPT] "${state.pendingUserText}" after ${silenceMs}ms silence`);
                  processTurn(state.pendingUserText, state, twilioWs);
                  state.pendingUserText = null;
                }
              }, 1100);
            };

            state.stt.onError = (err) => {
              console.error(`❌ Sarvam STT error:`, err);
            };
          };

          await connectSarvam();

          // Send welcome message
          setTimeout(async () => {
            let settings;
            if (state.isInbound) {
              console.log(`📥 Getting inbound settings for ${state.inboundPhoneNumber}`);
              settings = await getInboundCallSettings();
            } else {
              console.log(`📤 Getting outbound settings for ${state.streamSid}`);
              settings = await getCallSettings(state.streamSid);
            }
            
            if (!settings) {
              console.error("❌ Settings missing for first message!");
              const fallbackMessage = "Hello! How can I help you today?";
              console.log(`🎤 Using fallback message: "${fallbackMessage}"`);
              await speakText(fallbackMessage, state, twilioWs);
              return;
            }

            const firstMsg = settings.firstMessage || "Hello! How can I help you today?";
            console.log(`🎤 AI FIRST MESSAGE (${state.isInbound ? 'INBOUND' : 'OUTBOUND'}): "${firstMsg}"`);

            await speakText(firstMsg, state, twilioWs, {
              voice: settings.sarvamVoice || "karun",
              languageCode: settings.sarvamLanguage || "hi-IN",
              pace: 1.0
            });
          }, 800);

          return;
        }

        if (evt.event === "media") {
          const mulawChunk = Buffer.from(evt.media.payload, "base64");

          // Convert μ-law to linear PCM for Sarvam STT
          const linear8k = new Int16Array(mulawChunk.length);
          for (let i = 0; i < mulawChunk.length; i++) {
            const mu = ~mulawChunk[i] & 0xff;
            let t = ((mu & 0x0f) << 3) + 33;
            t = (t << ((mu & 0x70) >> 4)) - 33;
            linear8k[i] = (mu & 0x80) ? -t : t;
          }

          audioBuffer = Buffer.concat([audioBuffer, Buffer.from(linear8k.buffer)]);

          // Send chunks to STT when we have enough audio
          while (audioBuffer.length >= MIN_CHUNK_TO_SEND) {
            const toSend = audioBuffer.slice(0, MIN_CHUNK_TO_SEND);
            audioBuffer = audioBuffer.slice(MIN_CHUNK_TO_SEND);

            if (state.stt && typeof state.stt.sendAudio === 'function') {
              state.stt.sendAudio(toSend);
              console.log(`[AUDIO] Sent ${toSend.length} bytes to STT`);
            } else {
              console.warn("[AUDIO] STT not ready — dropping chunk");
            }
          }

          // Interruption detection: check volume if bot is speaking
          if (state.botSpeaking) {
            const volume = calculateVolume(mulawChunk);
            if (volume > 500) { // Adjust threshold based on testing
              console.log(`[INTERRUPT] User interruption detected (volume: ${volume})`);
              state.stopAudio();
              state.metrics.interruptsCount++;
            }
          }
        }

        if (evt.event === "stop") {
          console.log(`📞 Call ended by Twilio (${state.isInbound ? 'INBOUND' : 'OUTBOUND'})`);
          
          // Update call log if inbound
          if (state.isInbound && state.inboundCallSid) {
            try {
              await db.query(
                `UPDATE call_logs 
                 SET status = 'completed', ended_at = CURRENT_TIMESTAMP
                 WHERE call_sid = $1`,
                [state.inboundCallSid]
              );
            } catch (dbError) {
              console.error("Error updating inbound call log:", dbError);
            }
          }
          
          cleanup();
        }
      } catch (e) {
        console.error("WS message error:", e);
      }
    });

    twilioWs.on("close", () => {
      console.log(`📞 Twilio WebSocket closed (${state.isInbound ? 'INBOUND' : 'OUTBOUND'})`);
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
      }
      // Clean up settings
      if (state.streamSid) {
        callSettings.delete(state.streamSid);
        streamToCallMap.delete(state.streamSid);
      }
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

  const callSid = state.streamSid;
  if (!callSid) {
    console.warn("[processTurn] No streamSid available");
    return;
  }

  const settings = await getCallSettings(callSid);
  if (!settings) {
    console.warn(`[processTurn] No settings found for ${callSid}`);
    return;
  }

  // Quick filter — already done in onTranscript, but double-check
  const cleaned = userText.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (cleaned.length < 6 || words.length < 2) {
    console.log(`[SKIP short] "${cleaned}"`);
    return;
  }

  console.log(`[USER FINAL] "${cleaned}"  (${words.length} words)`);

  // Build conversation history
  const conversation = sessions.get(callSid) || [];

  // Detect if this is likely the first real user message
  const isFirstRealMessage = conversation.filter(m => m.role === 'user').length <= 1;

  const kbContext = settings.knowledgeChunks
    ?.slice(0, 4)
    ?.map(c => c.content)
    ?.join('\n\n───\n') || '';

  // Strong, repetition-resistant English system prompt
  const systemPrompt = `
You are Alex — a calm, concise.

STRICT RULES YOU MUST ALWAYS FOLLOW:
1. Never repeat greetings like "Hello", "Hi", "How can I help you today?" after the very first message
2. If the user says short affirmations ("ok", "yeah", "sure", "got it", "yes", "no", "right") → do NOT greet again. Continue the previous topic or ask a short clarifying question
3. Always read and consider ALL previous messages before replying (never lose context)
4. Keep most replies 1–2 natural sentences (max ~40 words)
5. Speak like a normal, friendly professional: use "you", "got it", "sure", "no problem", "let me check", "sounds good", etc.
6. Do NOT speak after the call has ended — always check state.botSpeaking
7. If you don't understand → politely ask for clarification instead of guessing wildly
8. Never generate multiple replies for the same user input

Current knowledge / company info (use only when relevant):
${kbContext ? kbContext : "(no specific knowledge available)"}

Stay helpful, natural, and concise. Avoid repeating yourself.
  `.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversation.slice(-10), // keep last 10 turns to prevent token explosion
    { role: "user", content: cleaned }
  ];

  // Safety: don't respond if call already ended
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
    console.warn("[processTurn] Twilio WS not open — skipping response");
    state.botSpeaking = false;
    return;
  }

  // Generate AI response
  let botReply;
  try {
    botReply = await aiResponse(
      null, // collect full reply (no direct streaming here)
      messages,
      settings.aiModel || "gpt-4o-mini",
      settings.temperature ?? 0.7,
      settings.maxTokens ?? 180
    );

    botReply = (botReply || "").trim();

    if (!botReply || botReply.length < 10) {
      botReply = "Sorry, I didn't quite catch that. Could you say it again?";
    }

    // Simple repeat prevention
    const lastBotMsg = conversation.filter(m => m.role === "assistant").slice(-1)[0]?.content;
    if (lastBotMsg && botReply.includes(lastBotMsg.slice(0, 35))) {
      botReply = "Got it. Could you give me a bit more detail please?";
    }

  } catch (err) {
    console.error("[LLM error]", err);
    botReply = "Sorry, something went wrong on my end. One moment please.";
  }

  // Speak with interruption & cleanup protection
  state.lastUserActivity = Date.now();

  await speakText(botReply, state, twilioWs, {
    voiceId: settings.elevenLabsVoiceId,
    stability: settings.elevenLabsStability ?? 0.9,
    similarityBoost: settings.elevenLabsSimilarityBoost ?? 0.85,
    speed: settings.elevenLabsSpeed ?? 1.05,
    aggressive: true,
    voice: settings.sarvamVoice || "karun",
    languageCode: settings.sarvamLanguage || "hi-IN",
    speed: settings.elevenLabsSpeed ?? 1.05,
  });

  // Update history
  conversation.push(
    { role: "user", content: cleaned, ts: Date.now() },
    { role: "assistant", content: botReply, ts: Date.now() }
  );

  // Trim history if too long
  if (conversation.length > 24) {
    conversation.splice(0, conversation.length - 20);
  }

  sessions.set(callSid, conversation);

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

  state.interrupted = false;
  state.botSpeaking = true;

  try {
    console.log(`[SPEAK START] "${text.slice(0,80)}..."`);

    const totalBytes = await ttsManager.generateAndStream(
      text,
      {
        voice: ttsOptions.voice || "karun",
        languageCode: "kn-IN",  // Tamil text → use ka-IN (critical for clean prosody)
        pitch: 0.0,
        pace: ttsOptions.pace ?? 1.05,
      },
      twilioWs,
      state
    );

    // Only handle interruption AFTER full generation/streaming
    if (state.interrupted) {
      console.log("[SPEAK] Interrupted post-generation — clearing");
      sendClearEvent(twilioWs, state.streamSid);
      return;
    }

    console.log(`[SPEAK] Completed streaming ${totalBytes} bytes`);
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







// fastify.all("/twiml", async (request, reply) => {
//   try {
//     const callSid = request.body.CallSid || request.query.CallSid;
//     if (!callSid) {
//       const msg = "Hi! Can we speak for a minute.";
//       console.error(msg);
//       return reply.type("text/xml").send(
//         `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Say voice="alice">${msg}</Say>
// </Response>`
//       );
//     }

//    const settings = await callSettings.get(callSid);


//     if (!settings) {
//       const msg = "Hi! is it right time to talk ?.";
//       console.error(msg);
//       return reply.type("text/xml").send(
//         `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
//  <Say voice="alice">${msg}</Say>
// </Response>`
//       );
//     }

//     // Optional: log missing fields for debug
//     const requiredFields = [
//       "elevenLabsVoiceId",
//       "elevenLabsSpeed",
//       "elevenLabsStability",
//       "elevenLabsSimilarityBoost",
//       "transcriberProvider",
//       "transcriberLanguage",
//       "transcriberModel",
//       "firstMessage"
//     ];
//     const missing = requiredFields.filter(f => !settings[f]);
//     if (missing.length > 0) {
//       console.warn(`⚠️ Missing fields in callSettings for ${callSid}:`, missing.join(", "));
//     }

//     const combinedVoice = `${settings.elevenLabsVoiceId}-${settings.elevenLabsSpeed}_${settings.elevenLabsStability}_${settings.elevenLabsSimilarityBoost}`;

//     // Construct TwiML
//     const twiml = `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
  

//   <Connect>
//     <ConversationRelay
//       url="wss://call.capalar.com/ws?callSid=${callSid}"
//       ttsProvider="ElevenLabs"
//       voice="${combinedVoice}"
//       elevenlabsTextNormalization="on"
//       transcriberProvider="${settings.transcriberProvider || 'deepgram'}"
//       transcriberLanguage="${settings.transcriberLanguage || 'en'}"
//       transcriberModel="${settings.transcriberModel || 'nova-2'}"
//       welcomeGreeting="${settings.firstMessage || 'Hello! How can I help you today?'}"
//     />
//   </Connect>
// </Response>`;

//     reply.type("text/xml").send(twiml);

//   } catch (error) {
//     console.error("❌ Error generating TwiML:", error);
//     reply.type("text/xml").send(
//       `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Say voice="alice">Internal Server Error: ${error.message}</Say>
// </Response>`
//     );
//   }
// });

// fastify.post("/call-me", async (request, reply) => {

//   const {

//     number: toNumber,

//     twilioAccountSid,

//     twilioAuthToken,

//     twilioPhoneNumber,

//     elevenLabsVoiceId,

//     elevenLabsSpeed,

//     elevenLabsStability,

//     elevenLabsSimilarityBoost,

//     transcriberProvider,

//     transcriberLanguage,

//     transcriberModel,

//     aiModel,

//     temperature,

//     systemPrompt,

//     firstMessage,

//     maxTokens,

//     agentId

//   } = request.body;
 
//   if (!toNumber || !/^\+\d+$/.test(toNumber)) {

//     return reply.code(400).send({ error: "Invalid or missing 'number'" });

//   }
 
//   const client = Twilio(twilioAccountSid, twilioAuthToken);
 
//   try {

//     // Fetch calendar + knowledge (workflow commented out)

//     const [calendarConfig, /* workflow, */ knowledgeChunks] = await Promise.all([

//       getAgentCalendarConfig(agentId),

//       // getActiveWorkflowForAgent(agentId),

//       preFetchAgentKnowledge(agentId)

//     ]);
 
//     // // Determine start node for workflow (commented out)

//     // const startNode = workflow?.nodes?.find(

//     //   (n) => !workflow.edges.some((e) => e.to_node_id === n.id)

//     // );
 
//     // Enhance system prompt with calendar data (if available)

//     const enhancedSystemPrompt = createEnhancedSystemPrompt(systemPrompt, calendarConfig);
 
  
// // Store all call-related context

//   // Create the Twilio call
//     const call = await client.calls.create({

//       to: toNumber,

//       from: twilioPhoneNumber,

//       url: `https://${DOMAIN}/twiml`,

//       record: true,

//       recordingChannels: "dual",

//     });
 
//           callSettings.set(call.sid, {

//       agentId,

//       agentName: calendarConfig?.agent_name || "Agent",

//       agentEmail: calendarConfig?.agent_email,

//       elevenLabsVoiceId,

//       elevenLabsSpeed,

//       elevenLabsStability,

//       elevenLabsSimilarityBoost,

//       transcriberProvider,

//       transcriberLanguage,

//       transcriberModel,

//       aiModel,

//       temperature: parseFloat(temperature),

//       systemPrompt: enhancedSystemPrompt,

//       firstMessage,

//       maxTokens: parseInt(maxTokens, 10),
 
//       // Calendar configuration

//       calendarConfig: calendarConfig

//         ? {

//             calendar_provider: calendarConfig.calendar_provider,

//             calendar_access_token: calendarConfig.calendar_access_token,

//             calendar_refresh_token: calendarConfig.calendar_refresh_token,

//             calendar_email: calendarConfig.calendar_email,

//             effective_timezone: calendarConfig.effective_timezone,

//             is_active: calendarConfig.is_active,

//           }

//         : null,
 
//       // Meeting scheduling state

//       meetingData: {

//         email: null,

//         datetime: null,

//         location: null,

//         purpose: "discovery call",

//         confirmationAttempts: 0,

//       },
 
//       // Available functions for meeting scheduling

//       availableFunctions: createAvailableFunctions(calendarConfig),
 
//       // // Workflow-related context (commented out)

//       // workflow,

//       // currentNodeId: startNode?.id,

//       // extractedVariables: {},
 
//       // Knowledge still active

//       knowledgeChunks,
 
//       // Twilio creds for later use

//       twilioAccountSid,

//       twilioAuthToken,

//     });

  
 
//     console.log(`📞 Outbound call initiated to ${toNumber}. SID: ${call.sid}`);

//     console.log(`📅 Calendar config: ${calendarConfig ? "Available" : "Not configured"}`);
 
//     reply.send({

//       success: true,

//       callSid: call.sid,

//       to: toNumber,

//       calendarEnabled: !!calendarConfig,

//     });

//   } catch (err) {

//     console.error("❌ Failed to create outbound call:", err);

//     reply

//       .code(500)

//       .send({ error: "Failed to create call", details: err.message });

//   }

// });
 



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

fastify.register(workflowRoutes, { prefix: '/api' });

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

// =============================================================================
// INBOUND CALL TWIML ENDPOINT
// =============================================================================

fastify.all('/inbound-call', async (request, reply) => {
  try {
    const fromNumber = request.body.From || request.query.From;
    const toNumber = request.body.To || request.query.To;
    
    console.log(`📥 Inbound call from ${fromNumber} to ${toNumber}`);
    
    let config = null;
    
    try {
      // Fetch configuration from database
      console.log(`🔍 Querying database for phone: ${toNumber}`);
      const result = await db.query(
        'SELECT * FROM inbound_configs WHERE phone_number = $1',
        [toNumber]
      );
      
      if (result.rows.length > 0) {
        config = result.rows[0];
        console.log(`✅ Found inbound config for ${toNumber} (agent: ${config.agent_id})`);
      } else {
        console.log(`⚠️ No config found for ${toNumber}, using default`);
      }
    } catch (dbError) {
      console.error('Database error fetching inbound config:', dbError);
      console.error('Stack trace:', dbError.stack);
    }
    
    const vr = new Twilio.twiml.VoiceResponse();
    
    // If config found, use its settings
    if (config) {
      // Optional: Play greeting message
      if (config.greeting_message) {
        vr.say({ voice: 'alice' }, config.greeting_message);
      }
      
      // Connect to configured WebSocket
      const connect = vr.connect();
      const streamUrl = `wss://${config.server_domain}${config.stream_path || '/ws-direct'}?inbound=true&phoneNumber=${encodeURIComponent(toNumber)}&agentId=${encodeURIComponent(config.agent_id)}`;
      
      console.log(`🔗 Connecting to WebSocket: ${streamUrl}`);
      connect.stream({
        url: streamUrl,
      });
    } else {
      // Default fallback
      console.log(`🔄 Using default fallback for ${toNumber}`);
      vr.say({ voice: 'alice' }, "Hello! Welcome to our service.");
      
      const connect = vr.connect();
      const defaultUrl = `wss://${DOMAIN}/ws-direct?inbound=true&phoneNumber=${encodeURIComponent(toNumber)}`;
      console.log(`🔗 Default WebSocket URL: ${defaultUrl}`);
      
      connect.stream({
        url: defaultUrl,
      });
    }
    
    reply.type("text/xml").send(vr.toString());
    
  } catch (error) {
    console.error("❌ Error generating inbound TwiML:", error);
    console.error("Stack trace:", error.stack);
    reply.type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">Sorry, we're experiencing technical difficulties. Please try again later.</Say>
      </Response>`
    );
  }
});

fastify.register(async function (fastify) {
  fastify.get("/preview-agent-ws", { websocket: true }, (ws, req) => {
    const sessionId = req.query.sessionId || `preview-${Date.now()}`; // Unique session ID for preview
    console.log(`⚙️ WebSocket setup for preview session: ${sessionId}`);

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        switch (message.type) {
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "setup":
            // Initialize session with provided settings
            const {
              agentId,
              aiModel,
              temperature,
              maxTokens,
              systemPrompt,
              firstMessage,
            } = message.payload;
            // Initialize conversation with firstMessage
            sessions.set(sessionId, [{ role: "assistant", content: firstMessage || "How can I help you today?" }]);
            callSettings.set(sessionId, {
              agentId,
              aiModel: aiModel || "gpt-4",
              temperature: parseFloat(temperature) || 0.7,
              maxTokens: parseInt(maxTokens, 10) || 256,
              systemPrompt: systemPrompt || "You are a helpful AI agent designed for phone-like conversations.",
              firstMessage,
              extractedVariables: {},
              workflow: null,
              currentNodeId: null,
              knowledgeChunks: [],
            });

            // Pre-fetch workflow and knowledge
            const [workflow, knowledgeChunks] = await Promise.all([
              getActiveWorkflowForAgent(agentId),
              preFetchAgentKnowledge(agentId),
            ]);
            const startNode = workflow?.nodes?.find(
              (n) => !workflow.edges.some((e) => e.to_node_id === n.id)
            );
            callSettings.get(sessionId).workflow = workflow;
            callSettings.get(sessionId).currentNodeId = startNode?.id;
            callSettings.get(sessionId).knowledgeChunks = knowledgeChunks;

            console.log(`⚙️ Preview session setup for agentId: ${agentId}`);
            ws.send(JSON.stringify({ type: "setup", success: true, sessionId }));
            // Removed: ws.send(JSON.stringify({ type: "text", token: firstMessage, last: true }));
            break;

          case "prompt":
            const { userInput } = message;
            console.log(`🎤 Preview prompt: ${userInput}`);
            const settings = callSettings.get(sessionId);
            if (!settings) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Session not found. Please start a new session.",
                })
              );
              return;
            }

            const conversation = sessions.get(sessionId) || [];
            conversation.push({ role: "user", content: userInput });

            const currentWorkflow = settings.workflow;
            const currentNodeId = settings.currentNodeId;
            const currentKnowledgeChunks = settings.knowledgeChunks;
            const currentNode = currentWorkflow?.nodes?.find((n) => n.id === currentNodeId);

            // Build dynamic prompt
            let dynamicPrompt = settings.systemPrompt;
            if (currentNode) {
              const nodeConfig =
                typeof currentNode.config === "string"
                  ? JSON.parse(currentNode.config)
                  : currentNode.config;
              dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
              if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
              if (Object.keys(settings.extractedVariables).length > 0) {
                dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(
                  settings.extractedVariables
                )}`;
              }
            }

            const combinedKnowledge = currentKnowledgeChunks.map(chunk => chunk.content).join("\n\n");
            dynamicPrompt += "\n\nContext:\n" + combinedKnowledge;
            const messages = [
              { role: "system", content: dynamicPrompt },
              ...conversation,
            ];

            // Stream AI response
            const response = await aiResponse(
              ws,
              messages,
              settings.aiModel,
              settings.temperature,
              settings.maxTokens
            );
            console.log("🤖 AI response:", response);

            // Extract variables if needed
            if (currentNode?.config?.variableExtractionPlan) {
              const newVariables = await extractVariables(
                userInput,
                currentNode.config.variableExtractionPlan
              );
              settings.extractedVariables = {
                ...settings.extractedVariables,
                ...newVariables,
              };
              console.log("📝 Extracted variables:", newVariables);
            }

            // Determine next node
            if (currentWorkflow && currentNodeId) {
              const nextNodeId = determineNextNode(currentWorkflow, currentNodeId, response, userInput);
              if (nextNodeId) {
                settings.currentNodeId = nextNodeId;
                console.log(`⏭️ Moving to next node: ${nextNodeId}`);
              }
            }

            conversation.push({ role: "assistant", content: response });
            sessions.set(sessionId, conversation);
            break;

          case "end":
            console.log(`🛑 Preview session ended: ${sessionId}`);
            sessions.delete(sessionId);
            callSettings.delete(sessionId);
            ws.close();
            break;

          default:
            console.warn(`⚠️ Unknown message type: ${message.type}`);
        }
      } catch (err) {
        console.error("❌ WebSocket error:", err);
        ws.send(
          JSON.stringify({ type: "error", message: `Error: ${err.message}` })
        );
      }
    });




    ws.on("close", () => {
      console.log(`🛑 WebSocket closed for session: ${sessionId}`);
      sessions.delete(sessionId);
      callSettings.delete(sessionId);
    });
  });
});
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🚀 Server running at http://0.0.0.0:${PORT} and wss://${DOMAIN}/ws`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

