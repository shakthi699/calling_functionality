// services/workflowEngine.js

export class WorkflowEngine {
  constructor(workflow) {
    this.workflow = workflow;
    this.nodes = workflow.nodes;
    this.edges = workflow.edges;

    console.log("🟢 ===== WORKFLOW INITIALIZED =====");
    console.log("Workflow ID:", workflow.id);
    console.log("Total Nodes:", this.nodes.length);
    console.log("Total Edges:", this.edges.length);
    console.log("===================================");
  }

 getStartNode() {
  const startNode = this.nodes.find(n => n.is_start === true);
  console.log("🚀 Start Node Selected:", startNode?.name);
  return startNode;
}

  getNodeById(id) {
    return this.nodes.find(n => n.id === id);
  }
async aiSelectNextNode(currentNodeId, userText, state) {

  console.log("🤖 AI deciding next node for:", userText);
  const edges = this.edges.filter(
    e => e.from_node_id === currentNodeId
  );

  if (!edges.length) return null;

  const possibleNodes = edges.map(e => {
    const node = this.getNodeById(e.to_node_id);
    return {
      id: node.id,
      name: node.name
    };
  });

  const response = await state.openai.chat.completions.create({
    model: state.aiModel || "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
      content: `
You are deciding which workflow node should handle the user request.

Return ONLY the node ID.

Available nodes:
${possibleNodes.map(n => `${n.id}: ${n.name}`).join("\n")}
`

      },
      {
        role: "user",
        content: userText
      }
    ]
  });

  // const selectedName =
  //   response.choices[0].message.content.trim();

  // const selected = possibleNodes.find(
  //   n => n.name.toLowerCase() === selectedName.toLowerCase()
  // );

  const selectedId = response.choices[0].message.content.trim();

const selected = possibleNodes.find(
  n => n.id === selectedId
);

  // if (!selected) return null;
  if (!selected) {
  console.warn("⚠️ AI failed → using default fallback");

  const defaultEdge = edges.find(
    e => e.condition?.type === "default"
  );

  if (defaultEdge) {
    return this.getNodeById(defaultEdge.to_node_id);
  }

  console.warn("⚠️ No default edge found");
  return null;
}

  return this.getNodeById(selected.id);
}
  // 🔥 NEW: Conditional Routing
getNextNodeByCondition(currentNodeId, userText = "") {
  console.log("➡️ Finding next node from:", currentNodeId);

  const edges = this.edges.filter(
    e => e.from_node_id === currentNodeId
  );

  if (!edges.length) {
    console.warn("⚠️ No outgoing edges from:", currentNodeId);
    return null;
  }

  const lowerText = userText.toLowerCase();

  // 🔥 0️⃣ Handle DIRECT condition first


  // 1️⃣ Check keyword conditions
  for (const edge of edges) {
    const condition = edge.condition;

    if (condition?.type === "keyword") {
      const match = condition.keywords?.some(keyword =>
        lowerText.includes(keyword.toLowerCase())
      );

      if (match) {
        const node = this.getNodeById(edge.to_node_id);
        console.log("✅ Keyword match → Routing to:", node?.name);
        return node;
      }
    }
  }

  // 2️⃣ Check default condition
const defaultEdge = edges.find(
  e => e.condition?.type === "default"
);

if (defaultEdge) {
  const node = this.getNodeById(defaultEdge.to_node_id);
  console.log("➡️ Default route → Routing to:", node?.name);
  return node;
}

// 3️⃣ Finally fallback to direct
const directEdge = edges.find(
  e => e.condition?.type === "direct"
);

if (directEdge) {
  const node = this.getNodeById(directEdge.to_node_id);
  console.log("➡️ Direct fallback → Routing to:", node?.name);
  return node;
}

  console.warn("⚠️ No matching condition found");
  return null;
}



async executeNode(node, state, twilioWs, speakText, endCall, userText = "") {
    if (!node) return null;

    console.log("\n🧠 ===== WORKFLOW NODE EXECUTION =====");
    console.log("Node Name:", node.name);
    console.log("Node Type:", node.type);
    console.log("=======================================");

    switch (node.type) {



case "conversation": {

  // const userText =
  //   state.fullTranscript?.slice(-1)[0]?.text || "";
const inputText = userText || "";
 if (!inputText.trim()) {
  if (node.config?.prompt) {
    await speakText(node.config.prompt, state, twilioWs, {
      transcriberLanguage: state.transcriberLanguage,
      languageCode: state.transcriberLanguage,
      sarvamVoice: state.sarvamVoice,
      elevenLabsVoiceId: state.elevenLabsVoiceId,
      elevenLabsSpeed: state.elevenLabsSpeed,
      elevenLabsStability: state.elevenLabsStability,
      elevenLabsSimilarityBoost: state.elevenLabsSimilarityBoost,
      pace: 1.15
    });
  }
  return null;
}

  console.log("🧠 Workflow conversation mode:", node.name);

  // ✅ USE PREFETCHED KNOWLEDGE (same as working server)
  const kbContext = (state.knowledgeChunks || [])
    .slice(0, 3)
    .map(c => c.content)
    .join("\n\n");

//   const response = await state.openai.chat.completions.create({
//     model: state.aiModel,
//     temperature: state.temperature,
//     messages: [
//       {
//         role: "system",
//         content: `
// You are a professional AI call assistant.
// Be concise and natural.
// Use knowledge if relevant.
// If unsure, ask a short clarifying question.
//         `
//       },
//       ...(kbContext
//         ? [{ role: "system", content: `Knowledge:\n${kbContext}` }]
//         : []),
//       {
//         role: "user",
//        content: inputText
//       }
//     ]
//   });

//   const reply = response.choices[0].message.content;
let hasSpoken = false;
let full = "";
let partial = "";
let spokenText = "";
const stream = await state.openai.chat.completions.create({
  model: state.aiModel,
  temperature: state.temperature,
  messages: [
    {
      role: "system",
      content: `
You are a professional AI call assistant.
Be concise and natural.
Keep answers under 20 words.
      `
    },
    ...(kbContext
      ? [{ role: "system", content: `Knowledge:\n${kbContext}` }]
      : []),
    {
      role: "user",
      content: inputText
    }
  ],
  stream: true
});

for await (const chunk of stream) {
  const token = chunk.choices?.[0]?.delta?.content || "";
  if (!token) continue;

  full += token;
  partial += token;

  // ⚡ SPEAK EARLY (KEY FIX)

}

const reply = full.trim();
// 🔥 IMPORTANT FIX — COMPLETE THE SENTENCE


  // ✅ SAVE BOT RESPONSE TO SESSION

const callSid = state.callSid;
const sessions = state.sessions;

if (callSid && sessions) {
  const conversation = sessions.get(callSid) || [];

  conversation.push({
    role: "assistant",
    content: reply,
    ts: Date.now()
  });

  sessions.set(callSid, conversation);
}

console.log("🤖 BOT:", reply);

 await speakText(reply, state, twilioWs, {
  transcriberLanguage: state.transcriberLanguage,
  languageCode: state.transcriberLanguage,
  sarvamVoice: state.sarvamVoice,
  elevenLabsVoiceId: state.elevenLabsVoiceId,
  elevenLabsSpeed: state.elevenLabsSpeed,
  elevenLabsStability: state.elevenLabsStability,
  elevenLabsSimilarityBoost: state.elevenLabsSimilarityBoost,
  pace: 1.15
});


  return null;
}
   case "decision": {

  console.log("🤖 AI deciding next node for:", userText);

  const nextNode =
    await this.aiSelectNextNode(node.id, userText, state);

  console.log("🤖 AI selected node:", nextNode?.name);

  return nextNode;
}

   case "end_call":

  console.log("📞 Workflow reached END_CALL node");

  await speakText(
    "Thank you for contacting Monospear. Have a great day. Goodbye.",
    state,
    twilioWs,
    {
      languageCode: state.transcriberLanguage,
      sarvamVoice: state.sarvamVoice,
      voice: state.sarvamVoice,
      elevenLabsVoiceId: state.elevenLabsVoiceId,
      elevenLabsSpeed: state.elevenLabsSpeed,
      elevenLabsStability: state.elevenLabsStability,
      elevenLabsSimilarityBoost: state.elevenLabsSimilarityBoost,
      pace: 1.15
    }
  );

  await new Promise(r => setTimeout(r, 600));

  console.log("📞 Ending call | Reason: workflow_end");

  try {
    twilioWs.close();
  } catch (e) {}

  return null;

      default:
        console.warn("⚠️ Unknown node type:", node.type);
        return null;
    }
  }
}