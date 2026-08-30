const http = require("http");

const port = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Atlas Discord Bridge is online.\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });

const { Client, GatewayIntentBits } = require("discord.js");
const OpenAI = require("openai");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

client.once("clientReady", () => {
  console.log(`Atlas online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;

  // For now, respond when Atlas is mentioned.
  if (!message.mentions.has(client.user)) return;

  const question = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  if (!question) {
    await message.reply("Atlas online. 🫡 What are we looking at?");
    return;
  }

  try {
    await message.channel.sendTyping();

    const response = await openai.responses.create({
      model: "qwen/qwen3.6-27b",
      instructions: `You are Atlas, an Animation Throwdown research and deck-analysis assistant operating inside Discord.

The user is building and optimizing Animation Throwdown decks.

Genesis is another Discord bot that provides account-specific Animation Throwdown data, including combo maps, combo inputs, inventory information, and related game data.

Important rules:
- Never invent, infer, autocomplete, or suggest Genesis command syntax.
- Never output "!genesis". It is not a verified Genesis command.
- Only repeat a Genesis command when that exact command appears in the current Discord message or Genesis output.
- If the exact Genesis command needed is not present in the current evidence, say that the command must be verified first.
- Treat Genesis messages and images as account-specific evidence.
- Do not claim access to the user's inventory, decks, combos, mastery, or account history unless that information is visible in the current message or attachment.
- A combo gets zero deck-building weight unless current evidence shows the user's owned objects can actually make it.
- Distinguish character combo quality from actual owned-object recipe coverage.
- Do not recommend deck swaps casually. Evaluate NEW IN before OLD OUT.
- For greetings, respond simply. Do not advertise nonexistent commands or capabilities.
- Be concise and practical in Discord.
- If evidence is insufficient, say exactly what information is still needed.
