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
  EmbedBuilder,
  MessageFlags // <-- CORRECCIÓN: Añadido MessageFlags
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
];

let rankingMessage = null; // Variable para almacenar el mensaje del ranking

/**
 * Construye el embed del ranking.
 * Esta función consulta la base de datos para el top 10 y el total de puntos.
 */
async function buildRankingEmbed(guild) {
  // 1. Obtener Top 10 Usuarios
  const resultUsuarios = await pool.query(
    'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10',
    [guild.id]
  );

  // 2. Obtener Puntos Totales Y Paquetes
  const resultStats = await pool.query(
    'SELECT total_puntos, paquetes_tienda FROM clan_stats WHERE guild = $1',
    [guild.id]
  );
  
  // Usamos valores por defecto si la tabla está vacía
  const stats = resultStats.rows[0] || { total_puntos: '0', paquetes_tienda: 0 };
  const totalPuntos = stats.total_puntos;
  const paquetesTienda = stats.paquetes_tienda;

  // 3. Construir el Embed
  const embed = new EmbedBuilder()
    .setTitle('🏆 Ranking del Clan')
    .setColor('Gold')
    .setImage(guild.iconURL()) // Logo en la parte inferior
    .setTimestamp();

  if (resultUsuarios.rows.length === 0) {
    embed.setDescription('No hay datos aún.');
  } else {
    const medallas = ['🥇', '🥈', '🥉'];

    // --- CORRECCIÓN PARA MÓVILES ---
    // Unimos el ranking en un solo string
    const rankingLines = resultUsuarios.rows.map((row, i) => {
      const rank = medallas[i] || `**${i + 1}.**`;
      const nombre = `**${row.usuario}**`;
      const puntos = `\`${row.puntos} pts\``;
      return `${rank} ${nombre} — ${puntos}`;
    }).join('\n');

    // Añadimos el campo de ranking
    embed.addFields({
      name: 'Ranking de Miembros',
      value: rankingLines,
      inline: false
    });

    // Añadimos el total
    embed.addFields({ 
      name: 'Total del Clan', 
      value: `**\`${BigInt(totalPuntos).toLocaleString('es')} pts\`**`,
      inline: false
    });
    
    // ¡NUEVO CAMPO PARA LA TIENDA!
    embed.addFields({
      name: 'Paquetes de tienda:',
      value: `**\`${paquetesTienda}\`**`,
      inline: false 
    });
  }
  
  return embed;
}

/**
 * Publica o actualiza el mensaje de ranking principal.
 */
const postRankingMessage = async () => {
  try {
    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ No se encontró el canal con ID ${process.env.RANKING_CHANNEL_ID}`);
      return;
    }

    if (!rankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      rankingMessage = pinned.find(m => m.author.id === client.user.id);
    }

    // Llamamos a la función 'buildRankingEmbed'
    const embed = await buildRankingEmbed(channel.guild);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('refresh_ranking')
        .setLabel('🔄 Actualizar ahora')
        .setStyle(ButtonStyle.Primary), // Azul, acción principal
      new ButtonBuilder()
        .setCustomId('view_full_ranking')
        .setLabel('➡️ Ver más')
        .setStyle(ButtonStyle.Secondary) // Gris, acción secundaria
    );

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

  // Publica el ranking al iniciar y luego cada 5 minutos
  await postRankingMessage();
  setInterval(postRankingMessage, 5 * 60 * 1000);
});

client.on(Events.MessageCreate, (message) => {
  if (message.webhookId && message.embeds?.length > 0) {
    const embed = message.embeds[0];
    const description = embed.description || embed.title || '';
    const guildId = message.guild?.id;

    if (!guildId) return console.warn('❌ No se pudo obtener el ID del servidor');

    // 1. Regex para el usuario (Esta no cambia)
    const matchUsuario = description.match(/\(([^)]+) ha conseguido (\d+) puntos[^)]*\)/si);
    if (matchUsuario) {
      const usuario = matchUsuario[1].trim();
      const puntos = parseInt(matchUsuario[2]);

      pool.query(`
        INSERT INTO puntos (guild, usuario, puntos)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild, usuario)
        DO UPDATE SET puntos = puntos.puntos + $3
      `, [guildId, usuario, puntos], (err) => {
        if (err) console.error('❌ Error al guardar puntos de usuario:', err);
        else console.log(`🟢 ${usuario} ganó ${puntos} puntos`);
      });
    }

    // --- LÓGICA DE PUNTOS TOTALES Y TIENDA (MODIFICADA) ---
    
    // 2. Regex para "Tienda de Almas" (La más específica DEBE ir primero)
    const matchTienda = description.match(/¡El clan LPCA ahora tiene\s+([0-9,.]+)\s+puntos de experiencia!\s+Tienda de Almas/si);

    if (matchTienda) {
      const totalPuntos = BigInt(matchTienda[1].replace(/[,.]/g, ''));
      console.log(`📦 ¡Paquete de tienda detectado! Actualizando total a ${totalPuntos}.`);

      // Actualiza AMBOS: el total Y el contador de paquetes
      pool.query(`
        INSERT INTO clan_stats (guild, total_puntos, paquetes_tienda)
        VALUES ($1, $2, 1)
        ON CONFLICT (guild)
        DO UPDATE SET 
          total_puntos = $2,
          paquetes_tienda = clan_stats.paquetes_tienda + 1
      `, [guildId, totalPuntos], (err) => {
        if (err) console.error('❌ Error al guardar stats (tienda):', err);
      });

    } else {
      // 3. Regex genérica (Solo se ejecuta si la de la tienda no coincidió)
      const matchTotal = description.match(/ahora tiene\s+([0-9,.]+)\s+puntos de experiencia/si);
      
      if (matchTotal) {
        const totalPuntos = BigInt(matchTotal[1].replace(/[,.]/g, ''));
        console.log(`🔵 Puntos totales (Genérico) actualizados: ${totalPuntos}`);

        // Actualiza SÓLO el total
        pool.query(`
          INSERT INTO clan_stats (guild, total_puntos)
          VALUES ($1, $2)
          ON CONFLICT (guild)
          DO UPDATE SET total_puntos = $2
        `, [guildId, totalPuntos], (err) => {
          if (err) console.error('❌ Error al guardar puntos totales (genérico):', err);
        });
      } else {
        console.warn('⚠️ No se encontró el total de puntos del clan en el webhook.');
      }
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;

  // Botón "Actualizar ahora"
  if (interaction.isButton() && interaction.customId === 'refresh_ranking') {
    // CORRECCIÓN: Cambiado a 'flags' para evitar el warning
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    // Llamamos a la función 'buildRankingEmbed'
    const embed = await buildRankingEmbed(interaction.guild);

    if (rankingMessage) {
      await rankingMessage.edit({ embeds: [embed] });
      await interaction.editReply({ content: '✅ Ranking actualizado.' });
    } else {
      await interaction.editReply({ content: '❌ No se pudo encontrar el mensaje de ranking.' });
    }
    return;
  }

  // Botón "Ver más"
  if (interaction.isButton() && interaction.customId === 'view_full_ranking') {
    // CORRECCIÓN: Cambiado a 'flags' para evitar el warning
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const pageSize = 10;
    let currentPage = 0;

    // Consulta para el total de páginas
    const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
    const totalRows = parseInt(totalResult.rows[0].count);
    const totalPages = Math.ceil(totalRows / pageSize) || 1;

    const displayPage = async (page) => {
      const offset = page * pageSize;

      // Consulta SQL optimizada con LIMIT y OFFSET
      const result = await pool.query(
        'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3',
        [interaction.guild.id, pageSize, offset]
      );
      
      const pageRows = result.rows;

      const lines = pageRows.map((row, i) => {
        const rank = offset + i + 1;
        return `${rank}. **${row.usuario}** — ${row.puntos} puntos`;
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('prev_page_full')
          .setLabel('⬅️ Anterior')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId('next_page_full')
          .setLabel('➡️ Siguiente')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1)
      );

      await interaction.editReply({
        content: `🏆 **Ranking completo (Página ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'No hay datos aún.'}`,
        components: [row],
      });
    };

    await displayPage(currentPage);

    const collector = interaction.channel.createMessageComponentCollector({
      filter: i => ['prev_page_full', 'next_page_full'].includes(i.customId) && i.user.id === interaction.user.id,
      time: 60_000
    });

    collector.on('collect', async i => {
      if (i.customId === 'prev_page_full') currentPage--;
      if (i.customId === 'next_page_full') currentPage++;
      await i.deferUpdate();
      await displayPage(currentPage);
    });

    collector.on('end', () => {
      interaction.editReply({ components: [] });
    });

    return;
  }

  // Comando /rankclan
  if (interaction.isChatInputCommand() && interaction.commandName === 'rankclan') {
    await interaction.deferReply(); // Defer público
    
    const pageSize = 10;
    let currentPage = 0;

    // Consulta para el total de páginas
    const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
    const totalRows = parseInt(totalResult.rows[0].count);
    const totalPages = Math.ceil(totalRows / pageSize) || 1;

    const fetchAndDisplay = async (page) => {
      try {
        const offset = page * pageSize;
        
        const result = await pool.query(
          'SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3',
          [interaction.guild.id, pageSize, offset]
        );

        const rows = result.rows;
        if (!rows.length) {
          return interaction.editReply({ content: '⚠️ No hay puntos registrados aún.' });
        }

        const lines = rows.map((row, i) => {
          const rank = offset + i + 1;
          return `${rank}. **${row.usuario}** — ${row.puntos} puntos`;
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page_cmd')
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('next_page_cmd')
            .setLabel('➡️ Siguiente')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= totalPages - 1)
        );

        await interaction.editReply({
          content: `🏆 **Ranking del Clan** (Página ${page + 1}/${totalPages}):\n\n${lines.join('\n')}`,
          components: [row]
        });

      } catch (err) {
        console.error(err);
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: '❌ Error al obtener el ranking.', components: [] });
        }
      }
    };

    await fetchAndDisplay(currentPage);

    const collector = interaction.channel.createMessageComponentCollector({
      filter: i => ['prev_page_cmd', 'next_page_cmd'].includes(i.customId) && i.user.id === interaction.user.id,
      time: 60_000
    });

    collector.on('collect', async i => {
      if (i.customId === 'prev_page_cmd') currentPage--;
      if (i.customId === 'next_page_cmd') currentPage++;
      await i.deferUpdate();
      await fetchAndDisplay(currentPage);
    });

    collector.on('end', () => {
      interaction.editReply({ components: [] });
    });
  }
});


// --- INICIO DEL BOT ---
// Usamos una función async auto-ejecutable para asegurar que las tablas
// existan ANTES de que el bot se conecte.

(async () => {
  try {
    console.log('Conectando a la base de datos...');
    
    // 1. Crear tabla 'puntos'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS puntos (
        guild TEXT,
        usuario TEXT,
        puntos INTEGER DEFAULT 0,
        PRIMARY KEY (guild, usuario)
      )
    `);
    console.log('✅ Tabla "puntos" lista');

    // 2. Crear tabla 'clan_stats'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clan_stats (
        guild TEXT PRIMARY KEY,
        total_puntos BIGINT DEFAULT 0
      )
    `);
    console.log('✅ Tabla "clan_stats" lista');

    // 3. AÑADIR LA NUEVA COLUMNA
    // Esto añade la columna 'paquetes_tienda' si no existe.
    await pool.query(`
      ALTER TABLE clan_stats
      ADD COLUMN IF NOT EXISTS paquetes_tienda INTEGER DEFAULT 0
    `);
    console.log('✅ Columna "paquetes_tienda" asegurada');
    
    // 4. Si todo va bien, inicia el bot
    console.log('Iniciando sesión en Discord...');
    await client.login(process.env.DISCORD_TOKEN);

  } catch (err) {
    console.error('❌ Error fatal durante el inicio:', err);
    process.exit(1); // Detiene el proceso si no se puede conectar a la DB
  }
})();
