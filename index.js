const http = require("http");
const crypto = require("crypto");
const { Client, GatewayIntentBits } = require("discord.js");
const OpenAI = require("openai");

const PORT = process.env.PORT || 10000;
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const BUFFER_MS = Number(process.env.GENESIS_BUFFER_MS || 1600);

const REQUIRED_ENV = [
  "DISCORD_BOT_TOKEN",
  "GROQ_API_KEY",
  "GENESIS_BOT_ID",
  "DISCORD_CHANNEL_ID",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
  }
}

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Peebles Genesis Bridge v2 is online.\n");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Peebles health server listening on port ${PORT}`);
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

// ---------------------------
// Verified command workflow
// ---------------------------

const EDUCATED_AUDIT = [
  "peggy",
  "professor farnsworth",
  "bob",
  "bender",
  "fry",
  "hayley",
  "gene",
  "hank",
  "bill",
  "amy",
  "stewie",
  "tina",
  "louise",
  "lois",
  "stan",
  "peter",
  "bobby",
  "zapp",
];

const sessions = new Map();
const genesisBuffers = new Map();

// Runtime channel binding. Human mention commands work in any channel.
// "start educated" binds Genesis watching to that channel until restart.
// Falls back to DISCORD_CHANNEL_ID after a restart.
let activeChannelId = process.env.DISCORD_CHANNEL_ID || null;
const seenGenesisMessageIds = new Map();
const recentPayloadHashes = new Map();

function newSession() {
  return {
    mode: "educated_audit",
    trait: "educated",
    audit: [...EDUCATED_AUDIT],
    // Already verified before this rebuild: Peggy, Professor Farnsworth,
    // Bob, Bender, Fry, Hayley, Gene. Continue at Hank.
    checked: new Set([
      "peggy",
      "professor farnsworth",
      "bob",
      "bender",
      "fry",
      "hayley",
      "gene",
    ]),
    currentCommand: null,
    awaitingGenesis: false,
    lastGenesisAt: 0,
    lastResult: null,
  };
}

function sessionFor(channelId) {
  if (!sessions.has(channelId)) sessions.set(channelId, newSession());
  return sessions.get(channelId);
}

function nextAuditCharacter(session) {
  return session.audit.find((name) => !session.checked.has(name)) || null;
}

function nextAuditCommand(session) {
  const name = nextAuditCharacter(session);
  return name ? `combos ${session.trait} ${name}` : null;
}

function normalize(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function commandCharacter(text, trait = "educated") {
  const n = normalize(text);
  const prefix = `combos ${trait} `;
  if (!n.startsWith(prefix)) return null;
  return n.slice(prefix.length).trim() || null;
}

function markCommandObserved(session, text) {
  const char = commandCharacter(text, session.trait);
  if (!char) return false;

  // Only accept commands that belong to the verified audit queue.
  if (!session.audit.includes(char)) return false;

  session.currentCommand = `combos ${session.trait} ${char}`;
  session.awaitingGenesis = true;
  return true;
}

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

  return [...new Set(urls)].slice(0, 3);
}

function payloadHash(text, imageUrls) {
  return crypto
    .createHash("sha256")
    .update(`${text}\n${imageUrls.join("\n")}`)
    .digest("hex");
}

function pruneTTL(map, ttlMs) {
  const now = Date.now();
  for (const [key, at] of map.entries()) {
    if (now - at > ttlMs) map.delete(key);
  }
}

function safeJson(text) {
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
    if (cut < 900) cut = 1800;
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
    if (replyMessage) await replyMessage.reply(remaining);
    else await channel.send(remaining);
  }
}

async function analyzeGenesis(genesisText, imageUrls, context) {
  const content = [
    {
      type: "text",
      text: `
You are Peebles, a literal evidence reader for Genesis Bot output from Animation Throwdown.

CURRENT WORKFLOW CONTEXT
Trait: ${context.trait}
Command believed to have triggered this result: ${context.currentCommand || "(unknown)"}

GENESIS MESSAGE TEXT
${genesisText || "(none)"}

TASK
Read the Genesis output literally. If images are supplied, inspect them carefully.

Return ONLY valid JSON with exactly these keys:
{
  "fully_readable": boolean,
  "unreadable": ["short descriptions of anything genuinely unreadable"],
  "combo_names": ["combo names visibly shown"],
  "visible_facts": ["other important literal facts visibly shown"],
  "no_combos_found": boolean,
  "confidence_note": "one short sentence"
}

HARD RULES
- Do not use outside game knowledge.
- Do not infer a name from artwork, portraits, icons, colors, card borders, or layout.
- Never invent Genesis command syntax.
- combo_names must contain only names visibly printed in this result.
- If Genesis explicitly says no combos were found, set no_combos_found=true and combo_names=[].
- If all meaningful text is readable, fully_readable=true and unreadable=[].
- Do not recommend deck changes here.
- Do not add commentary outside the JSON object.
      `.trim(),
    },
  ];

  for (const url of imageUrls) {
    content.push({
      type: "image_url",
      image_url: { url },
    });
  }

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content }],
    temperature: 0.05,
    max_completion_tokens: 1200,
    reasoning_effort: "none",
    response_format: { type: "json_object" },
  });

  return safeJson(completion.choices[0]?.message?.content || "{}");
}

function resultMessage(session, evidence) {
  const currentChar = commandCharacter(session.currentCommand || "", session.trait);
  if (currentChar) session.checked.add(currentChar);

  session.lastResult = evidence;
  session.lastGenesisAt = Date.now();
  session.awaitingGenesis = false;
  session.currentCommand = null;

  const lines = [];
  lines.push(evidence.fully_readable ? "**Fully readable. ✅**" : "**Not fully readable. ⚠️**");

  if (!evidence.fully_readable && Array.isArray(evidence.unreadable) && evidence.unreadable.length) {
    lines.push(`Unreadable: ${evidence.unreadable.join("; ")}`);
  }

  if (evidence.no_combos_found) {
    lines.push("Genesis found **no matching combos** for this result.");
  } else if (Array.isArray(evidence.combo_names) && evidence.combo_names.length) {
    const label = evidence.combo_names.length === 1 ? "combo" : "combos";
    lines.push(`${evidence.combo_names.length} ${label}: **${evidence.combo_names.join(", ")}**`);
  } else {
    lines.push("No combo names were safely extracted from this result.");
  }

  const next = nextAuditCommand(session);
  if (next) {
    lines.push(`\nNext command:\n\`\`\`\n${next}\n\`\`\``);
  } else {
    lines.push("\n**Educated character audit complete.** 📚✅");
  }

  return lines.join("\n");
}

async function processGenesisBuffer(channelId) {
  const buffer = genesisBuffers.get(channelId);
  if (!buffer) return;
  genesisBuffers.delete(channelId);

  const genesisText = buffer.texts.join("\n").trim();
  const imageUrls = [...new Set(buffer.imageUrls)].slice(0, 3);
  if (!genesisText && imageUrls.length === 0) return;

  pruneTTL(recentPayloadHashes, 60_000);
  const hash = payloadHash(genesisText, imageUrls);
  if (recentPayloadHashes.has(hash)) {
    console.log("Skipping duplicate Genesis payload.");
    return;
  }
  recentPayloadHashes.set(hash, Date.now());

  const session = sessionFor(channelId);

  try {
    await buffer.channel.sendTyping();
    const evidence = await analyzeGenesis(genesisText, imageUrls, session);
    console.log("Peebles evidence:", JSON.stringify(evidence));

    const response = resultMessage(session, evidence);
    await sendInChunks(buffer.channel, response);
  } catch (error) {
    console.error("Genesis processing error:", error);
    await buffer.channel.send(
      "Peebles saw Genesis, but the Groq analysis failed. Check the Render log for the exact error."
    );
  }
}

function queueGenesisMessage(message) {
  const channelId = message.channel.id;
  const session = sessionFor(channelId);

  // Critical guardrail: ignore unrelated Genesis traffic.
  // Peebles only reads Genesis after the user has typed the exact
  // verified audit command Peebles is waiting on.
  if (!session.awaitingGenesis || !session.currentCommand) {
    console.log("Ignoring unrelated Genesis result; no audit command is pending.");
    return;
  }

  pruneTTL(seenGenesisMessageIds, 5 * 60_000);

  if (seenGenesisMessageIds.has(message.id)) return;
  seenGenesisMessageIds.set(message.id, Date.now());
  const existing = genesisBuffers.get(channelId) || {
    channel: message.channel,
    texts: [],
    imageUrls: [],
    timer: null,
  };

  const text = String(message.content || "").trim();
  if (text) existing.texts.push(text);

  existing.imageUrls.push(...getImageUrls(message));
  existing.imageUrls = [...new Set(existing.imageUrls)].slice(0, 3);

  if (existing.timer) clearTimeout(existing.timer);
  existing.timer = setTimeout(
    () => processGenesisBuffer(channelId),
    BUFFER_MS
  );

  genesisBuffers.set(channelId, existing);
}

async function deterministicPeeblesCommand(message, question) {
  const session = sessionFor(message.channel.id);
  const q = normalize(question);

  if (!q || q === "help") {
    await message.reply(
      [
        "**Peebles v2** 🤖",
        "`@Peebles start educated` — reset/start the Educated audit",
        "`@Peebles next` — show the next Genesis command",
        "`@Peebles status` — show audit progress",
        "`@Peebles reset audit` — clear audit progress",
        "",
        "Peebles automatically watches Genesis in this channel. You do not need to screenshot Genesis results for Peebles.",
      ].join("\n")
    );
    return true;
  }

  if (q === "start educated" || q === "reset audit") {
    activeChannelId = message.channel.id;
    sessions.set(message.channel.id, newSession());
    const fresh = sessionFor(message.channel.id);
    console.log(`Peebles bound Educated audit to channel ${activeChannelId}`);
    await message.reply(
      `Educated audit bound to this channel. 📚✅\nNext command:\n\`\`\`\n${nextAuditCommand(fresh)}\n\`\`\``
    );
    return true;
  }

  if (q === "next") {
    const next = nextAuditCommand(session);
    await message.reply(
      next
        ? `Next command:\n\`\`\`\n${next}\n\`\`\``
        : "Educated character audit is complete. ✅"
    );
    return true;
  }

  if (q === "status") {
    const total = session.audit.length;
    const done = session.checked.size;
    const next = nextAuditCommand(session);
    await message.reply(
      [
        `**Educated audit:** ${done}/${total} checked`,
        `Bound channel: ${activeChannelId || "(none)"}`,
        `This channel: ${message.channel.id}`,
        `Pending Genesis: ${session.awaitingGenesis ? session.currentCommand : "(none)"}`,
        `Next: ${next || "complete ✅"}`,
      ].join("\n")
    );
    return true;
  }

  return false;
}

client.once("clientReady", () => {
  console.log(`Peebles online as ${client.user.tag}`);
  console.log(`Groq model: ${MODEL}`);
});

client.on("messageCreate", async (message) => {
  if (!client.user) return;
  if (message.author.id === client.user.id) return;

  const isGenesis = message.author.id === process.env.GENESIS_BOT_ID;
  const botWasMentioned =
    message.mentions.users.has(client.user.id) ||
    message.mentions.members?.has(client.user.id);

  // Diagnostic line for every relevant message event.
  if (isGenesis || botWasMentioned) {
    console.log(
      "Peebles message event:",
      JSON.stringify({
        channelId: message.channel.id,
        authorId: message.author.id,
        author: message.author.tag,
        isGenesis,
        botWasMentioned,
        content: message.content || "",
        activeChannelId,
        envChannelId: process.env.DISCORD_CHANNEL_ID || null,
      })
    );
  }

  // Genesis is only watched in the currently bound audit channel.
  if (isGenesis) {
    if (!activeChannelId || message.channel.id !== activeChannelId) {
      console.log(
        `Ignoring Genesis from channel ${message.channel.id}; active channel is ${activeChannelId || "(none)"}`
      );
      return;
    }
    queueGenesisMessage(message);
    return;
  }

  if (message.author.bot) return;

  // Track a literal audit command only in the bound channel.
  if (activeChannelId && message.channel.id === activeChannelId) {
    const session = sessionFor(message.channel.id);
    markCommandObserved(session, message.content);
  }

  // Human mention commands work in ANY channel.
  if (!botWasMentioned) return;

  let question = String(message.content || "");

  for (const [id] of message.mentions.users) {
    question = question
      .replaceAll(`<@${id}>`, " ")
      .replaceAll(`<@!${id}>`, " ");
  }

  question = question
    .replace(/<@!?\d+>/g, " ")
    .replace(/^\s*@?peebles\b[,:]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const rawLower = normalize(message.content);

  // Mobile Discord can make mention text ugly. Detect supported commands
  // from the raw message as a deterministic fallback.
  if (rawLower.includes("start educated")) question = "start educated";
  else if (rawLower.includes("reset audit")) question = "reset audit";
  else if (rawLower.includes("status")) question = "status";
  else if (rawLower.includes("next")) question = "next";
  else if (rawLower.includes("help")) question = "help";

  console.log("Peebles human command parsed as:", JSON.stringify(question));

  try {
    await message.channel.sendTyping();

    const handled = await deterministicPeeblesCommand(message, question);
    if (handled) return;

    await message.reply(
      "Use `@Peebles help`, `start educated`, `next`, `status`, or `reset audit`."
    );
  } catch (error) {
    console.error("Human command error:", error);
    await message.reply("Peebles hit an error. Check the Render log.");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
