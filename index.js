const http = require("http");
const { Client, GatewayIntentBits } = require("discord.js");
const OpenAI = require("openai");

const port = process.env.PORT || 10000;
const MODEL = "qwen/qwen3.8-27b";

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Atlas Discord Bridge is online.\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const recentHumanMessages = new Map();
const genesisBuffers = new Map();

const HUMAN_RULES = `
You are Atlas, an Animation Throwdown assistant inside Discord.

Hard rules:
- Never invent, infer, autocomplete, or advertise Genesis command syntax.
- Never output "!genesis" unless the user literally included that exact text in the current message.
- If exact Genesis syntax is not present in the current evidence, say it needs to be verified first.
- Never claim access to the user's inventory, decks, mastery, recipes, or account history unless that information is present in the current message.
- Do not invent card traits, TV shows, deck sizes, objects, recipes, mastery levels, or game categories.
- For a greeting, give a short greeting only. Do not advertise commands or capabilities.
- Be concise and practical.
`;

const GENESIS_ANALYSIS_RULES = `
You are Atlas analyzing account-specific output produced by the Genesis bot for Animation Throwdown.

Use ONLY the evidence supplied below. Do not use outside game knowledge to fill gaps.

Hard evidence rules:
- Never infer the meaning of an unlabeled icon, symbol, color, portrait, card art, background image, or visual motif.
- Never invent object names, character names, traits, shows, deck types, recipes, mastery, card ownership, fusion state, or deck size.
- Never claim an object makes a combo unless readable evidence explicitly says so.
- A character/trait combo map confirms the combos shown for that filter. It does NOT prove the user's owned objects can make those combos.
- "Representative Power" is Genesis comparison power for that result. It is NOT proof of the user's live deck power or owned card strength.
- Never suggest a deck swap from a combo map alone unless the evidence also establishes relevant owned-input coverage.
- Never invent or suggest Genesis command syntax.
- If a field is uncertain or absent, say it is not determinable from this result.

Output exactly these three short sections:
**VERIFIED FROM GENESIS**
Only facts directly supported by readable evidence.

**NOT DETERMINABLE FROM THIS RESULT**
Only important unknowns that matter to interpretation.

**DECK IMPACT**
A conservative conclusion. If the result is insufficient for a swap, say so plainly.
`;

function getImageUrls(message) {
  const urls = [];

  for (const attachment of message.attachments.values()) {
    const type = attachment.contentType || "";
    const name = attachment.name || "";

    if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(name)) {
      urls.push(attachment.url);
    }
  }

  for (const embed of message.embeds) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return [...new Set(urls)];
}

function parseJsonSafely(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  return JSON.parse(cleaned);
}

async function sendInChunks(channel, text, replyMessage = null) {
  let remaining = String(text || "").trim();
  if (!remaining) return;

  while (remaining.length > 1800) {
    let cut = remaining.lastIndexOf("\n", 1800);
    if (cut < 1000) cut = 1800;

    const chunk = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trim();

    if (replyMessage) {
      await replyMessage.reply(chunk);
      replyMessage = null;
    } else {
      await channel.send(chunk);
    }
  }

  if (remaining) {
    if (replyMessage) {
      await replyMessage.reply(remaining);
    } else {
      await channel.send(remaining);
    }
  }
}

async function extractLiteralGenesisEvidence(genesisText, imageUrls) {
  if (imageUrls.length === 0) {
    return {
      source_type: "genesis_text",
      visible_text: genesisText ? [genesisText] : [],
      explicit_label_value_pairs: [],
      unreadable_or_uncertain: [],
    };
  }

  const content = [
    {
      type: "text",
      text: `
You are a literal transcription engine for screenshots produced by the Genesis Animation Throwdown bot.

Your job is ONLY to extract visibly readable text. You are NOT analyzing the game.

Rules:
- Copy readable words, names, labels, numbers, and skill text as literally as possible.
- Do not name, describe, or interpret icons, symbols, portraits, artwork, colors, shapes, or backgrounds.
- Do not identify a character from artwork. A character name is valid only when printed as readable text.
- Do not infer missing words from game knowledge.
- Do not convert pictures into object names or game concepts.
- If text is blurry or uncertain, omit it from visible_text and describe only the location as uncertain, without guessing the word.
- Preserve numbers exactly as shown.
- Genesis message text supplied below may be copied as text evidence, but do not add facts to it.

Genesis message text:
${genesisText || "(none)"}
      `.trim(),
    },
  ];

  for (const url of imageUrls.slice(0, 3)) {
    content.push({
      type: "image_url",
      image_url: { url },
    });
  }

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content }],
    temperature: 0.1,
    max_completion_tokens: 1800,
    reasoning_effort: "none",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "literal_genesis_evidence",
        strict: true,
        schema: {
          type: "object",
          properties: {
            source_type: {
              type: "string",
              enum: ["genesis_image", "genesis_text_and_image"],
            },
            visible_text: {
              type: "array",
              items: { type: "string" },
            },
            explicit_label_value_pairs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                },
                required: ["label", "value"],
                additionalProperties: false,
              },
            },
            unreadable_or_uncertain: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "source_type",
            "visible_text",
            "explicit_label_value_pairs",
            "unreadable_or_uncertain",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = completion.choices[0]?.message?.content || "";
  return parseJsonSafely(raw);
}

async function analyzeGenesisEvidence(genesisText, evidence, precedingHumanText) {
  const prompt = `
${GENESIS_ANALYSIS_RULES}

PRECEDING HUMAN MESSAGE (context only, not proof of game facts):
${precedingHumanText || "(none)"}

GENESIS MESSAGE TEXT:
${genesisText || "(none)"}

LITERAL VISION EXTRACTION:
${JSON.stringify(evidence, null, 2)}

Important final check before answering:
If a noun or game fact is not literally present in GENESIS MESSAGE TEXT or LITERAL VISION EXTRACTION, do not introduce it as a fact.
  `.trim();

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_completion_tokens: 1000,
    reasoning_effort: "none",
  });

  return (
    completion.choices[0]?.message?.content ||
    "Atlas could not produce a grounded analysis of this Genesis result."
  ).trim();
}

async function answerHumanMessage(message, question) {
  const prompt = `
${HUMAN_RULES}

USER MESSAGE:
${question || "Hello"}
  `.trim();

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_completion_tokens: 700,
    reasoning_effort: "none",
  });

  const answer =
    completion.choices[0]?.message?.content ||
    "I couldn't produce an answer.";

  await sendInChunks(message.channel, answer, message);
}

function queueGenesisMessage(message) {
  const channelId = message.channel.id;
  const existing = genesisBuffers.get(channelId) || {
    channel: message.channel,
    texts: [],
    imageUrls: [],
    timer: null,
  };

  const text = message.content.trim();
  if (text) existing.texts.push(text);
  existing.imageUrls.push(...getImageUrls(message));
  existing.imageUrls = [...new Set(existing.imageUrls)].slice(0, 3);

  if (existing.timer) clearTimeout(existing.timer);

  existing.timer = setTimeout(async () => {
    genesisBuffers.delete(channelId);

    const genesisText = existing.texts.join("\n").trim();
    const humanContext = recentHumanMessages.get(channelId);
    const precedingHumanText =
      humanContext && Date.now() - humanContext.at < 60_000
        ? humanContext.text
        : "";

    if (!genesisText && existing.imageUrls.length === 0) return;

    try {
      await existing.channel.sendTyping();

      const evidence = await extractLiteralGenesisEvidence(
        genesisText,
        existing.imageUrls,
      );

      console.log(
        "Genesis literal evidence:",
        JSON.stringify(evidence),
      );

      const analysis = await analyzeGenesisEvidence(
        genesisText,
        evidence,
        precedingHumanText,
      );

      await sendInChunks(existing.channel, analysis);
    } catch (error) {
      console.error("Genesis analysis error:", error);
      await existing.channel.send(
        "Atlas saw the Genesis result but couldn't analyze it reliably. Check the Render log for the exact error.",
      );
    }
  }, 1400);

  genesisBuffers.set(channelId, existing);
}

client.once("clientReady", () => {
  console.log(`Atlas online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;

  const isGenesis =
    message.author.id === process.env.GENESIS_BOT_ID;
  const isTargetChannel =
    message.channel.id === process.env.DISCORD_CHANNEL_ID;

  if (!message.author.bot) {
    recentHumanMessages.set(message.channel.id, {
      text: message.content.trim(),
      at: Date.now(),
    });
  }

  if (isGenesis) {
    if (!isTargetChannel) return;
    queueGenesisMessage(message);
    return;
  }

  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const question = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  try {
    await message.channel.sendTyping();
    await answerHumanMessage(message, question);
  } catch (error) {
    console.error("Human message error:", error);
    await message.reply(
      "Atlas hit an API error. Check the Render log for the exact error.",
    );
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

