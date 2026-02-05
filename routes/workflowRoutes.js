import fastify from 'fastify';
import workflowController from '../controllers/workflowController.js';
 
async function workflowRoutes(fastify, options) {
  // Authentication middleware
  const authenticate = async (request, reply) => {
    try {
      const token = request.headers.authorization?.split(' ')[1];
     
      if (!token || token !== process.env.AUTH_TOKEN) {
        throw new Error('Invalid token');
      }
    } catch (err) {
      reply.code(401).send({ error: 'Authentication failed' });
    }
  };
 
  // Get workflow by ID
  fastify.get('/workflows/:id', {
    preHandler: authenticate
  }, workflowController.getWorkflow);
 
  // Get workflows for agent
  fastify.get('/workflows/agent/:agentId', {
    preHandler: authenticate
  }, workflowController.getWorkflowsForAgent);
 
  // Get workflow with nodes and edges
  fastify.get('/workflows/:id/full', {
    preHandler: authenticate
  }, workflowController.getWorkflowWithNodesAndEdges);

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
    const [workflow, knowledgeChunks] = await Promise.all([
      getActiveWorkflowForAgent(agentId),
      preFetchAgentKnowledge(agentId)
    ]);

    const startNode = workflow?.nodes?.find(n => !workflow.edges.some(e => e.to_node_id === n.id));
    let currentNodeId = startNode?.id;
    let extractedVariables = {};

    let dynamicPrompt = systemPrompt || "";
    if (startNode) {
      const nodeConfig = typeof startNode.config === 'string'
        ? JSON.parse(startNode.config)
        : startNode.config;
      dynamicPrompt += `\n\nCurrent Step: ${startNode.name}`;
      if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
    }

    const knowledgeContext = knowledgeChunks.map(chunk => chunk.content).join("\n\n");
    dynamicPrompt += '\n\nKnowledge Base:\n' + knowledgeContext;

    const messages = [
      { role: "system", content: dynamicPrompt },
      { role: "assistant", content: firstMessage || "How can I help you today?" },
      { role: "user", content: userInput }
    ];

    const completion = await openai.chat.completions.create({
      model: aiModel || "gpt-4",
      temperature: temperature !== undefined ? parseFloat(temperature) : 0.7,
      max_tokens: maxTokens !== undefined ? parseInt(maxTokens, 10) : 256,
      messages
    });

    const aiReply = completion.choices[0].message.content;

    if (startNode?.config?.variableExtractionPlan) {
      const newVariables = await extractVariables(
        userInput,
        startNode.config.variableExtractionPlan
      );
      extractedVariables = { ...extractedVariables, ...newVariables };
    }

    let nextNodeId = null;
    if (workflow && currentNodeId) {
      nextNodeId = determineNextNode(workflow, currentNodeId, aiReply, userInput);
    }

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
}


 
export default workflowRoutes;