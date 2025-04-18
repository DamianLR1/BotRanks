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
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Cliente del bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

// Conectar a base de datos SQLite
const db = new sqlite3.Database('./puntos.db');
db.run(`CREATE TABLE IF NOT EXISTS puntos (
  guild TEXT,
  usuario TEXT,
  puntos INTEGER DEFAULT 0,
  UNIQUE(guild, usuario)
)`);

// Definir comando slash
const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
];

// Registrar comandos slash en servidor específico
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Comando /rankclan registrado en el servidor');
  } catch (error) {
    console.error('❌ Error registrando el comando:', error);
  }
});

// Leer mensajes de webhook con embeds
client.on(Events.MessageCreate, (message) => {
  if (message.webhookId) {
    console.log('📥 Mensaje de Webhook recibido:', message.content);

    if (message.embeds && message.embeds.length > 0) {
      const embed = message.embeds[0];
      const match = embed.description?.match(/\(([^)]+) ha conseguido (\d+) puntos[^)]*\)/si) ||
                    embed.title?.match(/\(([^)]+) ha conseguido (\d+) puntos[^)]*\)/si);

      if (match) {
        const usuario = match[1].trim();
        const puntos = parseInt(match[2]);
        console.log(`✅ Detectado: ${usuario} ganó ${puntos} puntos`);

        const guildId = message.guild?.id;
        if (!guildId) {
          console.warn('❌ No se pudo obtener el ID del servidor');
          return;
        }

        db.run(`
          INSERT INTO puntos (guild, usuario, puntos) VALUES (?, ?, ?)
          ON CONFLICT(guild, usuario) DO UPDATE SET puntos = puntos + ?
        `, [guildId, usuario, puntos, puntos], (err) => {
          if (err) {
            console.error('❌ Error al guardar en DB:', err);
          } else {
            console.log('🟢 Puntos guardados correctamente');
          }
        });
      } else {
        console.log('❌ No se encontró el patrón esperado en el embed del webhook');
      }
    } else {
      console.log('❌ El mensaje del webhook no contiene embeds');
    }
  }
});

// Comando /rankclan con paginación
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'rankclan') return;

  const pageSize = 10;
  let currentPage = 0;

  const fetchAndDisplay = (page) => {
    db.all('SELECT usuario, puntos FROM puntos ORDER BY puntos DESC', (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.reply({ content: '❌ Error al obtener el ranking.', ephemeral: true });
      }

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

      if (interaction.replied) {
        interaction.editReply({
          content: `🏆 **Ranking del Clan** (Página ${page + 1}/${totalPages}):\n\n${lines.join('\n')}`,
          components: [row]
        });
      } else {
        interaction.reply({
          content: `🏆 **Ranking del Clan** (Página ${page + 1}/${totalPages}):\n\n${lines.join('\n')}`,
          components: [row]
        });
      }
    });
  };

  fetchAndDisplay(currentPage);

  const collector = interaction.channel.createMessageComponentCollector({
    filter: i => ['prev_page', 'next_page'].includes(i.customId) && i.user.id === interaction.user.id,
    time: 60_000 // 1 minuto
  });

  collector.on('collect', async i => {
    if (i.customId === 'prev_page') currentPage--;
    if (i.customId === 'next_page') currentPage++;
    await i.deferUpdate();
    fetchAndDisplay(currentPage);
  });

  collector.on('end', () => {
    interaction.editReply({ components: [] }); // Quita los botones después del timeout
  });
});

// Iniciar el bot
console.log("Token:", process.env.DISCORD_TOKEN);

