import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import cors from "@fastify/cors";
import { registerExotel,preloadInboundSettings } from "./exotel.server.js";
import { registerTwilio } from "./twilio.server.js";
import workflowRoutes from "../routes/workflowRoutes.js";
import multipart from '@fastify/multipart'
import { preFetchAgentKnowledge, aiResponse, loadWorkflowByAgent } from "./twilio.server.js";

export const sessions = new Map();
export const callSettings = new Map();
export const streamToCallMap = new Map();


const fastify = Fastify({
  logger: true,
  maxParamLength: 1024,
  requestTimeout: 10000,
  keepAliveTimeout: 65 * 1000,
});


fastify.addHook("onRequest", async (_, reply) => {
  reply.header("Cache-Control", "no-store");
});

fastify.register(fastifyWs);
fastify.register(fastifyFormBody);
fastify.register(multipart)
fastify.register(cors, { origin: "*" });


await registerTwilio(fastify, {
  sessions,
  callSettings,
  streamToCallMap
});

await registerExotel(fastify, {
  sessions,
  callSettings,
  streamToCallMap
});

await preloadInboundSettings();


// Register workflow routes once (centrally)
fastify.register(workflowRoutes, { prefix: '/api' });

// Unified entry
fastify.post("/call", async (req, reply) => {
  const { provider, number } = req.body;

  if (!provider || !["exotel", "twilio"].includes(provider)) {
    return reply.code(400).send({
      error: "provider must be either 'exotel' or 'twilio'"
    });
  }

  if (!number || !number.startsWith("+")) {
    return reply.code(400).send({
      error: "Phone number must be in E.164 format"
    });
  }

  const targetUrl =
    provider === "exotel"
      ? "/call-exotel"
      : "/call-me"; // Twilio

  const res = await fastify.inject({
    method: "POST",
    url: targetUrl,
    payload: req.body
  });

  reply.send({
    ...JSON.parse(res.payload),
    provider
  });
});





// fastify.register(async function (fastify) {
//   fastify.get("/preview-agent-ws", { websocket: true }, (ws, req) => {
//     const sessionId = req.query.sessionId || `preview-${Date.now()}`; // Unique session ID for preview
//     console.log(`⚙️ WebSocket setup for preview session: ${sessionId}`);

//     ws.on("message", async (data) => {
//       try {
//         const message = JSON.parse(data);
//         switch (message.type) {
//           case "ping":
//             ws.send(JSON.stringify({ type: "pong" }));
//             break;
//           case "setup":
//             // Initialize session with provided settings
//             const {
//               agentId,
//               aiModel,
//               temperature,
//               maxTokens,
//               systemPrompt,
//               firstMessage,
//             } = message.payload;
//             // Initialize conversation with firstMessage
//             sessions.set(sessionId, [{ role: "assistant", content: firstMessage || "How can I help you today?" }]);
//             callSettings.set(sessionId, {
//               agentId,
//               aiModel: aiModel || "gpt-4",
//               temperature: parseFloat(temperature) || 0.7,
//               maxTokens: parseInt(maxTokens, 10) || 256,
//               systemPrompt: systemPrompt || "You are a helpful AI agent designed for phone-like conversations.",
//               firstMessage,
//               extractedVariables: {},
//               workflow: null,
//               currentNodeId: null,
//               knowledgeChunks: [],
//             });

//             // Pre-fetch workflow and knowledge
//             const [workflow, knowledgeChunks] = await Promise.all([
//               getActiveWorkflowForAgent(agentId),
//               preFetchAgentKnowledge(agentId),
//             ]);
//             const startNode = workflow?.nodes?.find(
//               (n) => !workflow.edges.some((e) => e.to_node_id === n.id)
//             );
//             callSettings.get(sessionId).workflow = workflow;
//             callSettings.get(sessionId).currentNodeId = startNode?.id;
//             callSettings.get(sessionId).knowledgeChunks = knowledgeChunks;

//             console.log(`⚙️ Preview session setup for agentId: ${agentId}`);
//             ws.send(JSON.stringify({ type: "setup", success: true, sessionId }));
//             // Removed: ws.send(JSON.stringify({ type: "text", token: firstMessage, last: true }));
//             break;

//           case "prompt":
//             const { userInput } = message;
//             console.log(`🎤 Preview prompt: ${userInput}`);
//             const settings = callSettings.get(sessionId);
//             if (!settings) {
//               ws.send(
//                 JSON.stringify({
//                   type: "error",
//                   message: "Session not found. Please start a new session.",
//                 })
//               );
//               return;
//             }

//             const conversation = sessions.get(sessionId) || [];
//             conversation.push({ role: "user", content: userInput });

//             const currentWorkflow = settings.workflow;
//             const currentNodeId = settings.currentNodeId;
//             const currentKnowledgeChunks = settings.knowledgeChunks;
//             const currentNode = currentWorkflow?.nodes?.find((n) => n.id === currentNodeId);

//             // Build dynamic prompt
//             let dynamicPrompt = settings.systemPrompt;
//             if (currentNode) {
//               const nodeConfig =
//                 typeof currentNode.config === "string"
//                   ? JSON.parse(currentNode.config)
//                   : currentNode.config;
//               dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
//               if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
//               if (Object.keys(settings.extractedVariables).length > 0) {
//                 dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(
//                   settings.extractedVariables
//                 )}`;
//               }
//             }

//             const combinedKnowledge = currentKnowledgeChunks.map(chunk => chunk.content).join("\n\n");
//             dynamicPrompt += "\n\nContext:\n" + combinedKnowledge;
//             const messages = [
//               { role: "system", content: dynamicPrompt },
//               ...conversation,
//             ];

//             // Stream AI response
//             const response = await aiResponse(
//               ws,
//               messages,
//               settings.aiModel,
//               settings.temperature,
//               settings.maxTokens
//             );
//             console.log("🤖 AI response:", response);

//             // Extract variables if needed
//             if (currentNode?.config?.variableExtractionPlan) {
//               const newVariables = await extractVariables(
//                 userInput,
//                 currentNode.config.variableExtractionPlan
//               );
//               settings.extractedVariables = {
//                 ...settings.extractedVariables,
//                 ...newVariables,
//               };
//               console.log("📝 Extracted variables:", newVariables);
//             }

//             // Determine next node
//             if (currentWorkflow && currentNodeId) {
//               const nextNodeId = determineNextNode(currentWorkflow, currentNodeId, response, userInput);
//               if (nextNodeId) {
//                 settings.currentNodeId = nextNodeId;
//                 console.log(`⏭️ Moving to next node: ${nextNodeId}`);
//               }
//             }

//             conversation.push({ role: "assistant", content: response });
//             sessions.set(sessionId, conversation);
//             break;

//           case "end":
//             console.log(`🛑 Preview session ended: ${sessionId}`);
//             sessions.delete(sessionId);
//             callSettings.delete(sessionId);
//             ws.close();
//             break;

//           default:
//             console.warn(`⚠️ Unknown message type: ${message.type}`);
//         }
//       } catch (err) {
//         console.error("❌ WebSocket error:", err);
//         ws.send(
//           JSON.stringify({ type: "error", message: `Error: ${err.message}` })
//         );
//       }
//     });
//     ws.on("close", () => {
//       console.log(`🛑 WebSocket closed for session: ${sessionId}`);
//       sessions.delete(sessionId);
//       callSettings.delete(sessionId);
//     });
//   });
// });

fastify.register(async function (fastify) {
  fastify.get("/preview-agent-ws", { websocket: true }, (ws, req) => {
    const sessionId = req.query.sessionId || `preview-${Date.now()}`;
    console.log(`⚙️ WebSocket setup for preview session: ${sessionId}`);

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);

        switch (message.type) {

          /* ---------------------------------- */
          /* PING */
          /* ---------------------------------- */
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;

          /* ---------------------------------- */
          /* SETUP */
          /* ---------------------------------- */
          case "setup": {
            const {
  agentId,
  aiModel,
  temperature,
  maxTokens,
  systemPrompt,
  firstMessage,
  language
} = message.payload;

            sessions.set(sessionId, []);

            callSettings.set(sessionId, {
              agentId,
              aiModel: aiModel || "gpt-4o-mini",
              temperature: parseFloat(temperature) || 0.7,
              maxTokens: parseInt(maxTokens, 10) || 256,
              systemPrompt:
                systemPrompt ||
                "You are a helpful AI phone agent.",
              firstMessage:
                firstMessage ||
                "Hello, how can I help you today?",
              extractedVariables: {},
              workflow: null,
              currentNodeId: null,
              knowledgeChunks: [],

              /* ✅ duplicate guards */
              lastPrompt: "",
              lastPromptTime: 0,
              lastResponse: "",
            });

            const [workflow, knowledgeChunks] = await Promise.all([
              loadWorkflowByAgent(agentId),
              preFetchAgentKnowledge(agentId),
            ]);

            const settings = callSettings.get(sessionId);

            const startNode = workflow?.nodes?.find(
              (n) =>
                !workflow.edges.some(
                  (e) => e.to_node_id === n.id
                )
            );

            settings.workflow = workflow;
            settings.currentNodeId = startNode?.id ?? null;
            settings.knowledgeChunks = knowledgeChunks || [];

            console.log(
              `⚙️ Preview session setup for agentId: ${agentId}`
            );

            ws.send(
              JSON.stringify({
                type: "setup",
                success: true,
                sessionId,
              })
            );

            /* send greeting once */
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "text",
                  token: settings.firstMessage,
                  last: true,
                })
              );

              settings.lastResponse =
                settings.firstMessage;
            }

            break;
          }

          /* ---------------------------------- */
          /* PROMPT */
          /* ---------------------------------- */
          case "prompt": {
            const { userInput } = message;

            const settings =
              callSettings.get(sessionId);

            if (!settings) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Session expired",
                })
              );
              return;
            }

            /* ✅ duplicate prompt block */
            const now = Date.now();
            const cleanInput = (userInput || "")
              .trim()
              .toLowerCase();

            if (
              settings.lastPrompt === cleanInput &&
              now - settings.lastPromptTime < 2500
            ) {
              console.log(
                "⚠️ Duplicate prompt ignored:",
                userInput
              );
              return;
            }

            settings.lastPrompt = cleanInput;
            settings.lastPromptTime = now;

            console.log(
              `🎤 Preview prompt: ${userInput}`
            );

            const conversation =
              sessions.get(sessionId) || [];

            conversation.push({
              role: "user",
              content: userInput,
            });

            const currentWorkflow =
              settings.workflow;
            const currentNodeId =
              settings.currentNodeId;
            const currentKnowledgeChunks =
              settings.knowledgeChunks;

            const currentNode =
              currentWorkflow?.nodes?.find(
                (n) => n.id === currentNodeId
              );

        let dynamicPrompt = `
${settings.systemPrompt}

You are a phone AI assistant with access to a knowledge base.

IMPORTANT RULES:
- If user asks about any code, section, number, rule, CFR, statute, 4.124, 4.130, etc:
  ALWAYS search and answer from the provided knowledge base first.
- If exact section exists in context, summarize it clearly.
- If partial match exists, use nearest relevant match.
- Mention section number in answer when available.
- Never say you don't know if context contains answer.
- If answer is not in context, then politely say no matching info found.

Conversation Rules:
- Never greet again after first message
- Never reintroduce yourself
- Keep replies concise (20 words max unless detailed request)
- Natural human phone tone
- Ask one question at a time
- No repetition
`;

            if (currentNode) {
              const nodeConfig =
                typeof currentNode.config ===
                "string"
                  ? JSON.parse(
                      currentNode.config
                    )
                  : currentNode.config ?? {};

              dynamicPrompt += `\nCurrent Step: ${currentNode.name}`;

              if (nodeConfig.prompt) {
                dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
              }
            }

            if (
              currentKnowledgeChunks.length > 0
            ) {
              const combinedKnowledge =
                currentKnowledgeChunks
                  .map((c) => c.content)
                  .join("\n\n");

              dynamicPrompt += `\nContext:\n${combinedKnowledge}`;
            }

            const messages = [
              {
                role: "system",
                content: dynamicPrompt,
              },
              ...conversation,
            ];

            let response = "";

            try {
              response = await aiResponse(
                messages,
                settings.aiModel,
                settings.temperature,
                settings.maxTokens
              );
            } catch (err) {
              console.error(
                "❌ AI Error:",
                err.message
              );
              response =
                "Sorry, can you repeat that?";
            }

            /* trim long answer */
            response = response
              .split(".")
              .slice(0, 2)
              .join(".")
              .trim();

            if (!response) {
              response =
                "Could you repeat that?";
            }

            console.log(
              "🤖 AI response:",
              response
            );

            /* ✅ duplicate response block */
            if (
              settings.lastResponse !==
              response
            ) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "text",
                    token: response,
                    last: true,
                  })
                );
              }

              settings.lastResponse =
                response;
            } else {
              console.log(
                "⚠️ Duplicate response skipped"
              );
            }

            /* workflow move */
            if (
              currentWorkflow &&
              currentNodeId
            ) {
              const directEdge =
                currentWorkflow.edges.find(
                  (e) =>
                    e.from_node_id ===
                      currentNodeId &&
                    (e.condition?.type ===
                      "direct" ||
                      !e.condition)
                );

              if (directEdge) {
                settings.currentNodeId =
                  directEdge.to_node_id;

                console.log(
                  `⏭️ Moving to next node: ${directEdge.to_node_id}`
                );
              }
            }

            conversation.push({
              role: "assistant",
              content: response,
            });

            if (conversation.length > 10) {
              conversation.splice(
                0,
                conversation.length - 10
              );
            }

            sessions.set(
              sessionId,
              conversation
            );

            break;
          }

          /* ---------------------------------- */
          /* END */
          /* ---------------------------------- */
          case "end":
            console.log(
              `🛑 Preview session ended: ${sessionId}`
            );

            sessions.delete(sessionId);
            callSettings.delete(sessionId);

            ws.close();
            break;

          default:
            console.warn(
              `⚠️ Unknown message type: ${message.type}`
            );
        }
      } catch (err) {
        console.error(
          "❌ WebSocket error:",
          err
        );

        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: err.message,
            })
          );
        }
      }
    });

    ws.on("close", () => {
      console.log(
        `🛑 WebSocket closed for session: ${sessionId}`
      );

      sessions.delete(sessionId);
      callSettings.delete(sessionId);
    });
  });
});


await fastify.listen({ port: 8080, host: "0.0.0.0" });
