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
  // Never react to Atlas's own messages.
  if (message.author.id === client.user.id) return;

  const isGenesis = message.author.id === process.env.GENESIS_BOT_ID;
  const isTargetChannel =
    message.channel.id === process.env.DISCORD_CHANNEL_ID;
  const isAtlasMention = message.mentions.has(client.user);

  // Ignore every other bot except Genesis.
  if (message.author.bot && !isGenesis) return;

  // Only analyze Genesis in the configured channel.
  if (isGenesis && !isTargetChannel) return;

  // Human messages require an @Atlas mention.
  if (!isGenesis && !isAtlasMention) return;

  const question = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const imageUrls = [];

  for (const attachment of message.attachments.values()) {
    const type = attachment.contentType || "";
    const name = attachment.name || "";

    if (
      type.startsWith("image/") ||
      /\.(png|jpe?g|webp)$/i.test(name)
    ) {
      imageUrls.push(attachment.url);
    }
  }

  // Genesis may post an image as an embed instead of an attachment.
  for (const embed of message.embeds) {
    if (embed.image?.url) imageUrls.push(embed.image.url);
    if (embed.thumbnail?.url) imageUrls.push(embed.thumbnail.url);
  }

  const uniqueImageUrls = [...new Set(imageUrls)].slice(0, 3);

  if (isGenesis && !question && uniqueImageUrls.length === 0) return;

  const inputContent = [];

  if (isGenesis) {
    inputContent.push({
      type: "input_text",
      text:
        "This message came directly from the Genesis Animation Throwdown bot. " +
        "Treat it as account-specific evidence. Analyze what it shows and explain what it changes, if anything, for the user's deck decisions. " +
        "Do not invent or suggest Genesis command syntax." +
        (question ? `\n\nGenesis text:\n${question}` : ""),
    });
  } else {
    inputContent.push({
      type: "input_text",
      text:
        question ||
        "The user greeted Atlas. Reply with a brief greeting only.",
    });
  }

  for (const imageUrl of uniqueImageUrls) {
    inputContent.push({
      type: "input_image",
      detail: "auto",
      image_url: imageUrl,
    });
  }

  try {
    await message.channel.sendTyping();

    const response = await openai.responses.create({
  model: "qwen/qwen3.8-27b",
  reasoning: {
    effort: "none",
  },
  max_output_tokens: 1200,

      instructions: `You are Atlas, an Animation Throwdown research and deck-analysis assistant operating inside Discord.

Genesis is another Discord bot that provides account-specific Animation Throwdown data such as combo maps, combo inputs, inventory, decks, mastery information, and Siege data.

Important rules:
- Never invent, infer, autocomplete, or suggest Genesis command syntax.
- Never output "!genesis". It is not a verified Genesis command.
- Only repeat a Genesis command when that exact command is visible in the current message or image.
- If exact Genesis syntax is not visible, say the command must be verified first.
- Treat messages and images actually produced by Genesis as account-specific evidence.
- Do not claim access to inventory, decks, combos, mastery, or account history unless it is visible in the current evidence.
- A combo gets zero deck-building weight unless current evidence shows the user's owned objects can actually make it.
- Distinguish combo quality from owned-object recipe coverage.
- Do not recommend deck swaps casually. Follow NEW IN → OLD OUT.
- For greetings, greet the user briefly. Do not advertise commands or capabilities.
- Be concise and practical.
- If evidence is insufficient, state exactly what is missing.`,

      input: [
        {
          role: "user",
          content: inputContent,
        },
      ],
    });

    const fallbackText = (response.output || [])
  .flatMap((item) => item.content || [])
  .filter((part) => part.type === "output_text")
  .map((part) => part.text || "")
  .join("\n")
  .trim();

let answer = (
  response.output_text ||
  fallbackText ||
  ""
).trim();

if (!answer) {
  console.log(
    "Groq returned no final text:",
    response.status,
    response.incomplete_details,
    JSON.stringify(response.output)
  );

  answer =
    "I received the Genesis result, but Groq returned no final analysis.";
}

    while (answer.length > 1900) {
      const chunk = answer.slice(0, 1900);

      if (isGenesis) {
        await message.channel.send(chunk);
      } else {
        await message.reply(chunk);
      }

      answer = answer.slice(1900);
    }

    if (answer) {
      if (isGenesis) {
        await message.channel.send(answer);
      } else {
        await message.reply(answer);
      }
    }
  } catch (error) {
    console.error(error);

    if (!isGenesis) {
      await message.reply(
        "Atlas hit an API error. Check the service logs."
      );
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
