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

client.once("ready", () => {
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
- Never invent Genesis commands.
- Treat Genesis output as account-specific evidence.
- A combo gets zero deck-building weight unless the user's owned objects can actually make it.
- Distinguish character combo quality from actual owned-object recipe coverage.
- Do not recommend deck swaps casually. Evaluate NEW IN before OLD OUT.
- Be concise and practical in Discord.
- If evidence is insufficient, say exactly what information is still needed.`,
      input: question,
    });

    let answer = response.output_text || "I couldn't produce an answer.";

    while (answer.length > 1900) {
      const chunk = answer.slice(0, 1900);
      await message.reply(chunk);
      answer = answer.slice(1900);
    }

    await message.reply(answer);
  } catch (error) {
    console.error(error);
    await message.reply(
      "Atlas hit an API error. Check the service logs and environment variables."
    );
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
