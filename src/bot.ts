import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonInteraction,
  Interaction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import pg from "pg";

const { Pool } = pg;

// ── Database setup ─────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query(sql: string, values?: any[]) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, values);
    return res.rows;
  } finally {
    client.release();
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS vouches (
      id SERIAL PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      voucher_username TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      recipient_username TEXT NOT NULL,
      rating INTEGER NOT NULL,
      item TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL,
      game TEXT NOT NULL,
      category TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vouch_backups (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL UNIQUE,
      allowed_role_ids TEXT NOT NULL DEFAULT '[]',
      owner_id TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);
  console.log("✅ Database tables ready");
}

// ── Constants ──────────────────────────────────────────────────────────────
const STAR_EMOJIS: Record<number, string> = {
  1: "⭐",
  2: "⭐⭐",
  3: "⭐⭐⭐",
  4: "⭐⭐⭐⭐",
  5: "⭐⭐⭐⭐⭐",
};

const GAMES = [
  { label: "🎮 Roblox", value: "Roblox" },
  { label: "🕹️ Other", value: "Other" },
];

const CATEGORIES = [
  { label: "🐣 Adopt Me", value: "🐣 Adopt Me" },
  { label: "🧠 Steal a Brainrot", value: "🧠 Steal a Brainrot" },
  { label: "🍑 Blox Fruit", value: "🍑 Blox Fruit" },
  { label: "🔪 MM2", value: "🔪 MM2" },
  { label: "🐾 Pet Simulator", value: "🐾 Pet Simulator" },
];

const token = process.env.DISCORD_TOKEN!;
if (!token) {
  console.error("❌ DISCORD_TOKEN environment variable is not set!");
  process.exit(1);
}

// ── Bot client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// Multi-step vouch state keyed by userId-guildId
const vouchState = new Map<string, {
  recipientId: string;
  recipientUsername: string;
  rating?: number;
  game?: string;
  category?: string;
  channelId: string;
  guildId: string;
}>();

// ── Helpers ────────────────────────────────────────────────────────────────
async function getGuildSettings(guildId: string) {
  const rows = await query("SELECT * FROM guild_settings WHERE guild_id = $1 LIMIT 1", [guildId]);
  return rows[0] ?? null;
}

async function hasAdminRole(member: GuildMember, guildId: string): Promise<boolean> {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const settings = await getGuildSettings(guildId);
  if (!settings) return false;
  const roles: string[] = JSON.parse(settings.allowed_role_ids);
  return roles.some((roleId) => member.roles.cache.has(roleId));
}

async function isOwner(userId: string, guildId: string): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  return guild?.ownerId === userId;
}

// ── Register slash commands ────────────────────────────────────────────────
async function registerCommands(guildId?: string) {
  const commands = [
    new SlashCommandBuilder()
      .setName("vouch")
      .setDescription("Vouch for a user or check vouches")
      .addSubcommand((s) =>
        s.setName("give").setDescription("Vouch for another user")
          .addUserOption((o) => o.setName("user").setDescription("User to vouch for").setRequired(true))
      )
      .addSubcommand((s) =>
        s.setName("check").setDescription("Check a user's vouches")
          .addUserOption((o) => o.setName("user").setDescription("User to check").setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName("scam")
      .setDescription("Report a scam / remove your vouch")
      .addSubcommand((s) =>
        s.setName("vouch").setDescription("Remove your most recent vouch from a user")
          .addUserOption((o) => o.setName("user").setDescription("User to remove vouch from").setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("Add vouches to a user (admin only)")
      .addSubcommand((s) =>
        s.setName("vouches").setDescription("Add vouches")
          .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
          .addIntegerOption((o) => o.setName("amount").setDescription("Amount to add").setRequired(true).setMinValue(1))
      ),
    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Remove vouches from a user (admin only)")
      .addSubcommand((s) =>
        s.setName("vouches").setDescription("Remove vouches")
          .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
          .addIntegerOption((o) => o.setName("amount").setDescription("Amount to remove").setRequired(true).setMinValue(1))
      ),
    new SlashCommandBuilder()
      .setName("restore")
      .setDescription("Restore vouches from backup (admin only)")
      .addSubcommand((s) => s.setName("all").setDescription("Restore all vouches from latest backup")),
    new SlashCommandBuilder()
      .setName("setroles")
      .setDescription("Set which roles can manage vouches (owner only)")
      .addRoleOption((o) => o.setName("role").setDescription("Role to allow").setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST().setToken(token);
  const clientId = client.user!.id;

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ Commands registered for guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ Global commands registered");
  }
}

// ── Bot events ─────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  await initDb();
  for (const [guildId] of client.guilds.cache) {
    try { await registerCommands(guildId); } catch (e) { console.error(e); }
  }
});

client.on("guildCreate", async (guild) => {
  try { await registerCommands(guild.id); } catch (e) { console.error(e); }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleSlash(interaction as ChatInputCommandInteraction);
    else if (interaction.isStringSelectMenu()) await handleSelect(interaction as StringSelectMenuInteraction);
    else if (interaction.isModalSubmit()) await handleModal(interaction as ModalSubmitInteraction);
    else if (interaction.isButton()) await handleButton(interaction as ButtonInteraction);
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
    try {
      if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).followUp(msg);
      else await (interaction as any).reply(msg);
    } catch {}
  }
});

// ── Slash command handler ──────────────────────────────────────────────────
async function handleSlash(interaction: ChatInputCommandInteraction) {
  const { commandName, guildId, user } = interaction;
  if (!guildId) return interaction.reply({ content: "❌ Server-only command.", ephemeral: true });

  // /vouch give
  if (commandName === "vouch" && interaction.options.getSubcommand() === "give") {
    const target = interaction.options.getUser("user", true);
    if (target.id === user.id) return interaction.reply({ content: "❌ You can't vouch for yourself!", ephemeral: true });
    if (target.bot) return interaction.reply({ content: "❌ You can't vouch for a bot!", ephemeral: true });

    const stateKey = `${user.id}-${guildId}`;
    vouchState.set(stateKey, { recipientId: target.id, recipientUsername: target.username, channelId: interaction.channelId, guildId });

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`vouch_rating:${stateKey}`).setPlaceholder("Select a rating (1–5 stars)")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("⭐ 1 Star").setValue("1"),
          new StringSelectMenuOptionBuilder().setLabel("⭐⭐ 2 Stars").setValue("2"),
          new StringSelectMenuOptionBuilder().setLabel("⭐⭐⭐ 3 Stars").setValue("3"),
          new StringSelectMenuOptionBuilder().setLabel("⭐⭐⭐⭐ 4 Stars").setValue("4"),
          new StringSelectMenuOptionBuilder().setLabel("⭐⭐⭐⭐⭐ 5 Stars").setValue("5"),
        )
    );
    return interaction.reply({ content: `> Vouching for <@${target.id}>\n\n**⭐ Rating** — Choose a star rating:`, components: [row], ephemeral: true });
  }

  // /vouch check
  if (commandName === "vouch" && interaction.options.getSubcommand() === "check") {
    const target = interaction.options.getUser("user", true);
    await interaction.deferReply();

    const vouches = await query(
      "SELECT * FROM vouches WHERE recipient_id = $1 AND guild_id = $2 ORDER BY created_at DESC",
      [target.id, guildId]
    );

    if (vouches.length === 0) return interaction.editReply({ content: `📭 **${target.username}** has no vouches yet.` });

    const avg = (vouches.reduce((s: number, v: any) => s + v.rating, 0) / vouches.length).toFixed(1);
    const avgStars = STAR_EMOJIS[Math.round(Number(avg))] ?? "⭐";

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`📋 Vouches for ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`**Total Vouches:** ${vouches.length}\n**Average Rating:** ${avg}/5 ${avgStars}`)
      .setFooter({ text: `User ID: ${target.id}` });

    for (const v of vouches.slice(0, 5)) {
      embed.addFields({
        name: `${STAR_EMOJIS[v.rating] ?? "⭐"} Vouch by ${v.voucher_username}`,
        value: [
          `🎮 **Game:** ${v.game}`,
          `📦 **Category:** ${v.category}`,
          v.item ? `📦 **Item:** ${v.item}` : null,
          `💬 **Comment:** ${v.comment}`,
          `📅 <t:${Math.floor(new Date(v.created_at).getTime() / 1000)}:R>`,
        ].filter(Boolean).join("\n"),
        inline: false,
      });
    }

    if (vouches.length > 5) embed.setFooter({ text: `Showing 5 of ${vouches.length} vouches | User ID: ${target.id}` });
    return interaction.editReply({ embeds: [embed] });
  }

  // /scam vouch
  if (commandName === "scam" && interaction.options.getSubcommand() === "vouch") {
    const target = interaction.options.getUser("user", true);
    await interaction.deferReply({ ephemeral: true });

    const rows = await query(
      "SELECT * FROM vouches WHERE voucher_id = $1 AND recipient_id = $2 AND guild_id = $3 ORDER BY created_at DESC LIMIT 1",
      [user.id, target.id, guildId]
    );
    if (rows.length === 0) return interaction.editReply({ content: `❌ You haven't vouched for **${target.username}**.` });

    const v = rows[0];
    await query("DELETE FROM vouches WHERE id = $1", [v.id]);

    const scamEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🚨 Scam Report")
      .setDescription(`<@${user.id}> removed their vouch for <@${target.id}> and flagged them as a **SCAMMER**.`)
      .addFields(
        { name: "⭐ Removed Rating", value: STAR_EMOJIS[v.rating] ?? "⭐", inline: true },
        { name: "💬 Original Comment", value: v.comment, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ content: `✅ Your vouch for **${target.username}** has been removed.` });
    const channel = interaction.channel;
    if (channel?.isTextBased()) await channel.send({ embeds: [scamEmbed] });
    return;
  }

  // /add vouches
  if (commandName === "add" && interaction.options.getSubcommand() === "vouches") {
    const member = interaction.member as GuildMember;
    if (!(await hasAdminRole(member, guildId))) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);
    await interaction.deferReply({ ephemeral: true });

    for (let i = 0; i < amount; i++) {
      await query(
        "INSERT INTO vouches (voucher_id, voucher_username, recipient_id, recipient_username, rating, item, comment, game, category, guild_id, channel_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [user.id, `Admin (${user.username})`, target.id, target.username, 5, "Manually added by admin", "Manually added by admin", "Other", "Other", guildId, interaction.channelId]
      );
    }
    return interaction.editReply({ content: `✅ Added **${amount}** vouch(es) to <@${target.id}>.` });
  }

  // /remove vouches
  if (commandName === "remove" && interaction.options.getSubcommand() === "vouches") {
    const member = interaction.member as GuildMember;
    if (!(await hasAdminRole(member, guildId))) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);
    await interaction.deferReply({ ephemeral: true });

    const toRemove = await query(
      "SELECT id FROM vouches WHERE recipient_id = $1 AND guild_id = $2 ORDER BY created_at DESC LIMIT $3",
      [target.id, guildId, amount]
    );
    if (toRemove.length === 0) return interaction.editReply({ content: `❌ **${target.username}** has no vouches to remove.` });

    for (const row of toRemove) await query("DELETE FROM vouches WHERE id = $1", [row.id]);
    return interaction.editReply({ content: `✅ Removed **${toRemove.length}** vouch(es) from <@${target.id}>.` });
  }

  // /restore all
  if (commandName === "restore" && interaction.options.getSubcommand() === "all") {
    const member = interaction.member as GuildMember;
    if (!(await hasAdminRole(member, guildId))) return interaction.reply({ content: "❌ No permission.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });

    const backups = await query("SELECT * FROM vouch_backups WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1", [guildId]);
    if (backups.length === 0) return interaction.editReply({ content: "❌ No backup found." });

    let vouchData: any[];
    try { vouchData = JSON.parse(backups[0].data); } catch { return interaction.editReply({ content: "❌ Backup corrupted." }); }
    if (!Array.isArray(vouchData) || vouchData.length === 0) return interaction.editReply({ content: "❌ Backup is empty." });

    for (const v of vouchData) {
      await query(
        "INSERT INTO vouches (voucher_id, voucher_username, recipient_id, recipient_username, rating, item, comment, game, category, guild_id, channel_id, message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [v.voucher_id ?? v.voucherId, v.voucher_username ?? v.voucherUsername, v.recipient_id ?? v.recipientId, v.recipient_username ?? v.recipientUsername, v.rating, v.item ?? "", v.comment, v.game ?? "Other", v.category ?? "Other", guildId, v.channel_id ?? v.channelId ?? interaction.channelId, v.message_id ?? v.messageId ?? null]
      );
    }
    return interaction.editReply({ content: `✅ Restored **${vouchData.length}** vouch(es) from backup.` });
  }

  // /setroles
  if (commandName === "setroles") {
    if (!(await isOwner(user.id, guildId))) return interaction.reply({ content: "❌ Only the server owner can use this.", ephemeral: true });
    const role = interaction.options.getRole("role", true);
    await interaction.deferReply({ ephemeral: true });

    const existing = await getGuildSettings(guildId);
    const currentRoles: string[] = existing ? JSON.parse(existing.allowed_role_ids) : [];
    if (!currentRoles.includes(role.id)) currentRoles.push(role.id);

    if (existing) {
      await query("UPDATE guild_settings SET allowed_role_ids = $1, owner_id = $2 WHERE guild_id = $3", [JSON.stringify(currentRoles), user.id, guildId]);
    } else {
      await query("INSERT INTO guild_settings (guild_id, allowed_role_ids, owner_id) VALUES ($1, $2, $3)", [guildId, JSON.stringify(currentRoles), user.id]);
    }
    return interaction.editReply({ content: `✅ **${role.name}** can now manage vouches.\n**Allowed roles:** ${currentRoles.map((id) => `<@&${id}>`).join(", ")}` });
  }
}

// ── Select menu handler (vouch flow) ──────────────────────────────────────
async function handleSelect(interaction: StringSelectMenuInteraction) {
  const { customId, values, guildId } = interaction;
  if (!guildId) return;

  if (customId.startsWith("vouch_rating:")) {
    const stateKey = customId.replace("vouch_rating:", "");
    const state = vouchState.get(stateKey);
    if (!state) return interaction.reply({ content: "❌ Session expired. Run `/vouch give` again.", ephemeral: true });

    state.rating = parseInt(values[0]);
    vouchState.set(stateKey, state);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`vouch_game:${stateKey}`).setPlaceholder("Select a game")
        .addOptions(GAMES.map((g) => new StringSelectMenuOptionBuilder().setLabel(g.label).setValue(g.value)))
    );
    return interaction.update({
      content: `> Vouching for <@${state.recipientId}>\n\n**⭐ Rating:** ${STAR_EMOJIS[state.rating]}\n\n**🎮 Game** — Choose a game:`,
      components: [row],
    });
  }

  if (customId.startsWith("vouch_game:")) {
    const stateKey = customId.replace("vouch_game:", "");
    const state = vouchState.get(stateKey);
    if (!state) return interaction.reply({ content: "❌ Session expired. Run `/vouch give` again.", ephemeral: true });

    state.game = values[0];
    vouchState.set(stateKey, state);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`vouch_category:${stateKey}`).setPlaceholder("Select a category")
        .addOptions(CATEGORIES.map((c) => new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.value)))
    );
    return interaction.update({
      content: `> Vouching for <@${state.recipientId}>\n\n**⭐ Rating:** ${STAR_EMOJIS[state.rating!]}\n**🎮 Game:** ${state.game}\n\n**📦 Category** — Choose a category:`,
      components: [row],
    });
  }

  if (customId.startsWith("vouch_category:")) {
    const stateKey = customId.replace("vouch_category:", "");
    const state = vouchState.get(stateKey);
    if (!state) return interaction.reply({ content: "❌ Session expired. Run `/vouch give` again.", ephemeral: true });

    state.category = values[0];
    vouchState.set(stateKey, state);

    const modal = new ModalBuilder().setCustomId(`vouch_submit:${stateKey}`).setTitle("Finish Your Vouch");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("item").setLabel("📦 Item (what was traded/received?)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Permanent Dragon, 1000 Robux...").setRequired(true).setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("comment").setLabel("💬 Comment (your overall review)").setStyle(TextInputStyle.Paragraph).setPlaceholder("Write your comment here...").setRequired(true).setMaxLength(500)
      )
    );
    return interaction.showModal(modal);
  }
}

// ── Modal handler (save vouch + post embed) ────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const { customId, guildId, user } = interaction;
  if (!guildId) return;

  if (customId.startsWith("vouch_submit:")) {
    const stateKey = customId.replace("vouch_submit:", "");
    const state = vouchState.get(stateKey);
    if (!state) return interaction.reply({ content: "❌ Session expired. Run `/vouch give` again.", ephemeral: true });

    const item = interaction.fields.getTextInputValue("item");
    const comment = interaction.fields.getTextInputValue("comment");
    await interaction.deferReply({ ephemeral: true });

    // Backup before save
    try {
      const existing = await query("SELECT * FROM vouches WHERE guild_id = $1", [guildId]);
      if (existing.length > 0) await query("INSERT INTO vouch_backups (guild_id, data) VALUES ($1, $2)", [guildId, JSON.stringify(existing)]);
    } catch {}

    const [saved] = await query(
      "INSERT INTO vouches (voucher_id, voucher_username, recipient_id, recipient_username, rating, item, comment, game, category, guild_id, channel_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
      [user.id, user.username, state.recipientId, state.recipientUsername, state.rating, item, comment, state.game, state.category, guildId, state.channelId]
    );

    vouchState.delete(stateKey);

    const allVouches = await query("SELECT * FROM vouches WHERE recipient_id = $1 AND guild_id = $2", [state.recipientId, guildId]);
    const totalCount = allVouches.length;

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("🛒 New Vouch")
      .addFields(
        { name: "👤 Vouched By", value: `<@${user.id}>`, inline: false },
        { name: "🎯 Vouch To", value: `<@${state.recipientId}>`, inline: false },
        { name: "⭐ Rating", value: STAR_EMOJIS[state.rating!], inline: false },
        { name: "🎮 Game", value: state.game!, inline: false },
        { name: "📦 Category", value: state.category!, inline: false },
        { name: "📦 Item", value: item, inline: false },
        { name: "💬 Comment", value: comment, inline: false }
      )
      .setFooter({ text: `Vouched for ${state.recipientUsername} • Total vouches: ${totalCount}` })
      .setTimestamp();

    await interaction.editReply({ content: "✅ Your vouch has been submitted!" });

    const channel = client.channels.cache.get(state.channelId);
    if (channel?.isTextBased()) {
      const msg = await channel.send({ content: `<@${user.id}> <@${state.recipientId}>`, embeds: [embed] });
      await query("UPDATE vouches SET message_id = $1 WHERE id = $2", [msg.id, saved.id]);
    }
  }
}

async function handleButton(_interaction: ButtonInteraction) {}

// Auto-backup every 6 hours
setInterval(async () => {
  for (const [guildId] of client.guilds.cache) {
    try {
      const all = await query("SELECT * FROM vouches WHERE guild_id = $1", [guildId]);
      if (all.length > 0) {
        await query("INSERT INTO vouch_backups (guild_id, data) VALUES ($1, $2)", [guildId, JSON.stringify(all)]);
        console.log(`✅ Auto-backup guild ${guildId}: ${all.length} vouches`);
      }
    } catch (e) { console.error("Backup error:", e); }
  }
}, 6 * 60 * 60 * 1000);

// ── Start ──────────────────────────────────────────────────────────────────
client.login(token).catch((err) => {
  console.error("❌ Login failed:", err);
  process.exit(1);
});
