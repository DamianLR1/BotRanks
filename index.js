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
  ButtonStyle
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

// 🌐 Variables de entorno
const RANKING_CHANNEL_ID = process.env.RANKING_CHANNEL_ID;
let rankingMessage = null;

// 🛠️ Slash command
const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
];

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

  await postRankingMessage(); // Enviar ranking al arrancar
  setInterval(postRankingMessage, 5 * 60 * 1000); // Actualizar cada 5 min
});

// 🏆 Mensaje de ranking automático
const postRankingMessage = async () => {
  const channel = await client.channels.fetch(RANKING_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    return console.error('❌ Canal de ranking no válido o no es de texto.');
  }

  pool.query(
    'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10',
    [process.env.GUILD_ID],
    async (err, result) => {
      if (err) return console.error('❌ Error al obtener el ranking:', err);
      const rows = result.rows;
      if (!rows.length) return;

      const lines = rows.map((row, i) => `${i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
      const content = `🏆 **Ranking del Clan** (Top 10):\n\n${lines.join('\n')}`;

      try {
        if (!rankingMessage) {
          rankingMessage = await channel.send(content);
          await rankingMessage.pin();
          console.log('📌 Mensaje de ranking enviado y fijado');
        } else {
          await rankingMessage.edit(content);
          console.log('🔁 Ranking actualizado');
        }
      } catch (e) {
        console.error('❌ Error al enviar/editar mensaje:', e);
      }
    }
  );
};

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

      if (!guildId) return console.warn('❌ No se pudo obtener el ID del servidor');

      pool.query(`
        INSERT INTO puntos (guild, usuario, puntos)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild, usuario)
        DO UPDATE SET puntos = puntos.puntos + $3
      `, [guildId, usuario, puntos], (err) => {
        if (err) console.error('❌ Error al guardar en DB:', err);
        else console.log(`🟢 ${usuario} ganó ${puntos} puntos`);
      });
    }
  }
});

// 🏆 /rankclan con paginación
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'rankclan') return;

  const pageSize = 10;
  let currentPage = 0;

  const fetchAndDisplay = (page) => {
    pool.query(
      'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC',
      [interaction.guild.id],
      async (err, result) => {
        if (err) {
          console.error(err);
          return interaction.reply({ content: '❌ Error al obtener el ranking.', ephemeral: true });
        }

        const rows = result.rows;
        if (!rows.length) {
          return interaction.reply({ content: '⚠️ No hay puntos registrados aún.', ephemeral: true });
        }

        const totalPages = Math.ceil(rows.length / pageSize);
        const start = page * pageSize;
        const end = start + pageSize;
        const pageRows = rows.slice(start, end);

        const lines = pageRows.map((row, i) => {
          const rank = start + i + 1;
          return `${rank}. **${row.usuario}** — ${row.puntos} puntos`;
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('➡️ Siguiente')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= totalPages - 1)
        );

        const replyContent = {
          content: `🏆 **Ranking del Clan** (Página ${page + 1}/${totalPages}):\n\n${lines.join('\n')}`,
          components: [row]
        };

        if (interaction.replied) {
          await interaction.editReply(replyContent);
        } else {
          await interaction.reply(replyContent);
        }
      }
    );
  };

  fetchAndDisplay(currentPage);

  const collector = interaction.channel.createMessageComponentCollector({
    filter: i => ['prev_page', 'next_page'].includes(i.customId) && i.user.id === interaction.user.id,
    time: 60_000
  });

  collector.on('collect', async i => {
    if (i.customId === 'prev_page') currentPage--;
    if (i.customId === 'next_page') currentPage++;
    await i.deferUpdate();
    fetchAndDisplay(currentPage);
  });

  collector.on('end', () => {
    interaction.editReply({ components: [] });
  });
});

// 🔑 Login del bot
client.login(process.env.DISCORD_TOKEN);
