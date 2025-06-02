const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// 🔌 PostgreSQL
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

// Crear tabla si no existe
pool.query(`
  CREATE TABLE IF NOT EXISTS puntos (
    guild TEXT,
    usuario TEXT,
    puntos INTEGER DEFAULT 0,
    PRIMARY KEY (guild, usuario)
  )
`, (err) => {
  if (err) console.error('❌ Error creando tabla:', err);
  else console.log('✅ Tabla "puntos" lista');
});

// 🤖 Cliente del bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

// 🛠️ Slash command
const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
];

let rankingMessage = null;

// 📦 Registrar comandos al iniciar
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Comando /rankclan registrado');
  } catch (error) {
    console.error('❌ Error registrando el comando:', error);
  }

  // 🔁 Enviar y actualizar el ranking automáticamente
  const postRankingMessage = async () => {
    try {
      const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);

      if (!rankingMessage) {
        const pinned = await channel.messages.fetchPinned();
        rankingMessage = pinned.find(m => m.author.id === client.user.id);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('refresh_ranking')
          .setLabel('🔄 Actualizar ahora')
          .setStyle(ButtonStyle.Secondary)
      );

      const result = await pool.query(
        'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10',
        [process.env.GUILD_ID]
      );

      const lines = result.rows.map((row, i) => `${i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
      const embed = new EmbedBuilder()
        .setTitle('🏆 Ranking del Clan')
        .setDescription(lines.join('\n') || 'No hay datos aún.')
        .setColor(0xFFD700)
        .setTimestamp();

      if (!rankingMessage) {
        const msg = await channel.send({ embeds: [embed], components: [row] });
        await msg.pin();
        rankingMessage = msg;
      } else {
        await rankingMessage.edit({ embeds: [embed], components: [row] });
      }
    } catch (err) {
      console.error('❌ Error en postRankingMessage:', err);
    }
  };

  await postRankingMessage();
  setInterval(postRankingMessage, 5 * 60 * 1000);
});

// 📥 Mensajes de webhook con puntos
client.on(Events.MessageCreate, (message) => {
  if (message.webhookId && message.embeds?.length > 0) {
    const embed = message.embeds[0];
    const match = embed.description?.match(/\(([^)]+) ha conseguido (\d+) puntos[^)]*\)/si)
      || embed.title?.match(/\(([^)]+) ha conseguido (\d+) puntos[^)]*\)/si);

    if (match) {
      const usuario = match[1].trim();
      const puntos = parseInt(match[2]);
      const guildId = message.guild?.id;

      if (!guildId) return console
