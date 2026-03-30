// ==========================================
// 1. SISTEMA ANTI-DORMIR (KEEP-ALIVE RENDER)
// ==========================================
const http = require('http');
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('El bot esta activo y escuchando!');
}).listen(port, () => console.log(`🌍 Keep-Alive Server escuchando en puerto ${port}`));

// ==========================================
// 2. CÓDIGO DEL BOT
// ==========================================
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionsBitField
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// --- Funciones de Ayuda ---

function createProgressBar(value, maxValue, size = 10) {
  if (value <= 0 || maxValue <= 0) return '`[          ]`';
  const percentage = value / maxValue;
  const progress = Math.round(size * percentage);
  const filled = '█'; const empty = '░';
  return `\`[${filled.repeat(progress)}${empty.repeat(size - progress)}]\``;
}

async function fetchMessagesBetween(channel, startId, endId) {
  let allMessages = [];
  let lastId = startId;
  console.log(`[fetchMessagesBetween] Buscando mensajes DESPUÉS de ${startId} hasta ANTES o IGUAL a ${endId}`);
  try {
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after: lastId });
      if (messages.size === 0) { console.log(`[fetchMessagesBetween] No se encontraron más mensajes.`); break; }
      let reachedEnd = false;
      messages.forEach(msg => {
        if (BigInt(msg.id) <= BigInt(endId)) allMessages.push(msg);
        else reachedEnd = true;
      });
      lastId = messages.first().id;
      console.log(`[fetchMessagesBetween] ... ${allMessages.length} recopilados. Último ID: ${lastId}`);
      if (reachedEnd) { console.log(`[fetchMessagesBetween] ID final (${endId}) alcanzado.`); break; }
      if (allMessages.length > 10000) { console.warn('[fetchMessagesBetween] Límite de seguridad alcanzado.'); break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) { console.error('[fetchMessagesBetween] Error:', error); }
  console.log(`[fetchMessagesBetween] Finalizado. Total: ${allMessages.length}`);
  return allMessages;
}

// --- Configuración DB y Cliente ---

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// --- Comandos Slash ---

const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('estadisticas')
    .setDescription('Muestra estadísticas generales del clan')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('iniciar-evento')
    .setDescription('[Admin] Crea el anuncio del evento e inicia el rastreo de puntos.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cerrar-evento')
    .setDescription('[Admin] Cierra el evento activo y publica el podio final.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('calcular-evento-ids')
    .setDescription('[Admin] Calcula el ranking del evento basado en IDs de mensaje.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(option => option.setName('start_id').setDescription('ID del primer mensaje del evento').setRequired(true))
    .addStringOption(option => option.setName('end_id').setDescription('ID del último mensaje del evento').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('calcular-inicio')
    .setDescription('[Admin] Resetea el rastreo desde un ID anterior y sincroniza los puntos perdidos.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(option => option.setName('message_id').setDescription('ID del mensaje DESDE donde empezar a contar (exclusivo)').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('reiniciar-rank')
    .setDescription('[Admin] ⚠️ BORRA todos los puntos y reinicia el ranking a cero.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('evento-temporada')
    .setDescription('[Admin] Cambia el nombre del evento activo que aparece en el embed del ranking.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
];

// --- Estado en memoria ---
let rankingMessage = null;
let eventRankingMessage = null; // Mensaje del ranking en vivo del evento

// --- Funciones Principales ---

async function buildRankingEmbed(guild) {
  const resultUsuarios = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10', [guild.id]);
  const resultStats = await pool.query('SELECT total_puntos, temporada_nombre FROM clan_stats WHERE guild = $1', [guild.id]);
  const stats = resultStats.rows[0] || { total_puntos: '0', temporada_nombre: null };
  const topPoints = resultUsuarios.rows.length ? resultUsuarios.rows[0].puntos : 0;
  const temporadaNombre = stats.temporada_nombre || '🏆 TEMPORADA';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `TEMPORADA DE CLAN | ${temporadaNombre}` })
    .setTitle('➥ 🏆 Ranking del Clan')
    .setDescription('\u200B')
    .setColor('#E67E22').setImage(guild.iconURL()).setTimestamp();

  if (resultUsuarios.rows.length === 0) {
    embed.setDescription('No hay datos aún.');
  } else {
    const medallas = ['🥇', '🥈', '🥉'];
    const rankingLines = resultUsuarios.rows.map((row, i) => {
      const rank = medallas[i] || `**${i + 1}.**`;
      return `${rank} **${row.usuario}**\n   \`${row.puntos} pts\` ${createProgressBar(row.puntos, topPoints, 10)}`;
    }).join('\n\n');
    embed.addFields({ name: '➥ Ranking de Miembros', value: rankingLines, inline: false });
    embed.addFields({ name: '\u200B', value: '\u200B', inline: false });
    embed.addFields({ name: 'Total del Clan', value: `**\`${BigInt(stats.total_puntos).toLocaleString('es')} pts\`**`, inline: true });
  }
  return embed;
}

async function buildEventRankingEmbed(guild, eventId, eventName) {
  const result = await pool.query(
    'SELECT usuario, puntos FROM event_points WHERE guild = $1 AND event_id = $2 ORDER BY puntos DESC LIMIT 10',
    [guild.id, eventId]
  );
  const topPoints = result.rows.length ? result.rows[0].puntos : 0;
  const medallas = ['🥇', '🥈', '🥉'];

  const embed = new EmbedBuilder()
    .setAuthor({ name: `EVENTO EN CURSO` })
    .setTitle(`⚔️ Ranking — ${eventName}`)
    .setColor('#FF5733')
    .setImage(guild.iconURL())
    .setTimestamp();

  if (result.rows.length === 0) {
    embed.setDescription('Aún no hay puntos registrados para este evento.');
  } else {
    const lines = result.rows.map((row, i) => {
      const rank = medallas[i] || `**${i + 1}.**`;
      return `${rank} **${row.usuario}**\n   \`${row.puntos} pts\` ${createProgressBar(row.puntos, topPoints, 10)}`;
    }).join('\n\n');
    embed.addFields({ name: '➥ Ranking del Evento', value: lines, inline: false });
  }
  return embed;
}

async function processWebhookMessage(message, activeEvent = null) {
  if (!message.guild?.id || !message.webhookId || !message.embeds?.length) return;

  const embed = message.embeds[0];
  const description = embed.description || embed.title || '';
  const guildId = message.guild.id;

  // Detectar Puntos de Usuario - AMBOS FORMATOS
  const matchConParentesis = description.match(/\(([^)]+?) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
  const matchSinParentesis = description.match(/^[^(\n]*?!\s*([^\n(]+?) ha conseguido ([\d,.]+) puntos/sim);
  const matchUsuario = matchConParentesis || matchSinParentesis;

  if (matchUsuario) {
    const usuario = matchUsuario[1].trim();
    const puntosStr = matchUsuario[2];
    const puntosLimpio = puntosStr.replace(/[.,]/g, '');
    const puntos = parseInt(puntosLimpio);

    if (!isNaN(puntos)) {
      try {
        // Siempre actualizar el ranking general
        await pool.query(
          `INSERT INTO puntos (guild, usuario, puntos) VALUES ($1, $2, $3)
           ON CONFLICT (guild, usuario) DO UPDATE SET puntos = puntos.puntos + $3`,
          [guildId, usuario, puntos]
        );
        const formato = matchConParentesis ? 'con paréntesis' : 'sin paréntesis';
        console.log(`[PROCESS] 🟢 ${usuario} ganó ${puntos} pts (formato: ${formato}) (ID: ${message.id})`);

        // Si hay evento activo, también actualizar event_points
        if (activeEvent) {
          await pool.query(
            `INSERT INTO event_points (guild, event_id, usuario, puntos) VALUES ($1, $2, $3, $4)
             ON CONFLICT (guild, event_id, usuario) DO UPDATE SET puntos = event_points.puntos + $4`,
            [guildId, activeEvent.id, usuario, puntos]
          );
          console.log(`[EVENT] ➕ ${usuario} ganó ${puntos} pts en evento #${activeEvent.id}`);
        }
      } catch (err) {
        console.error(`[PROCESS] ❌ Error al guardar puntos para ${usuario}:`, err);
      }
    }
  }

  // Detectar Puntos Totales del Clan
  const matchTotal = description.match(/ahora tiene\s+([0-9,.]+)\s+puntos de experiencia/si);
  if (matchTotal) {
    const totalPuntos = BigInt(matchTotal[1].replace(/[,.]/g, ''));
    try {
      await pool.query(
        `INSERT INTO clan_stats (guild, total_puntos) VALUES ($1, $2)
         ON CONFLICT (guild) DO UPDATE SET total_puntos = $2`,
        [guildId, totalPuntos]
      );
      console.log(`[PROCESS] 🔵 Total actualizado: ${totalPuntos} (ID: ${message.id})`);
    } catch (err) {
      console.error('[PROCESS] ❌ Error al guardar puntos totales:', err);
    }
  }
}

async function getActiveEvent(guildId) {
  const result = await pool.query(
    'SELECT * FROM events WHERE guild = $1 AND status = $2 LIMIT 1',
    [guildId, 'active']
  );
  return result.rows[0] || null;
}

async function syncRecentPoints(channelId, guildId) {
  console.log(`[SYNC] 🚀 Iniciando sincronización...`);
  let lastProcessedId = process.env.RESET_MESSAGE_ID;
  try {
    const result = await pool.query('SELECT last_processed_message_id FROM clan_stats WHERE guild = $1', [guildId]);
    if (result.rows.length > 0 && result.rows[0].last_processed_message_id) {
      lastProcessedId = result.rows[0].last_processed_message_id;
      console.log(`[SYNC] Último ID en DB: ${lastProcessedId}`);
    } else {
      console.log(`[SYNC] Usando RESET_MESSAGE_ID por defecto: ${lastProcessedId}`);
    }
    if (!lastProcessedId) { console.warn('[SYNC] ⚠️ No hay ID para sincronizar.'); return; }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.messages) { console.error(`[SYNC] ❌ Canal ${channelId} no encontrado.`); return; }

    const activeEvent = await getActiveEvent(guildId);
    let newMessages = [];
    let currentLastId = lastProcessedId;
    let newestMessageIdInSync = lastProcessedId;

    console.log(`[SYNC] Buscando mensajes NUEVOS después de ${currentLastId}...`);
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after: currentLastId });
      if (messages.size === 0) { console.log(`[SYNC] No hay mensajes más nuevos.`); break; }
      messages.forEach(msg => {
        newMessages.push(msg);
        if (BigInt(msg.id) > BigInt(newestMessageIdInSync)) newestMessageIdInSync = msg.id;
      });
      currentLastId = messages.first().id;
      console.log(`[SYNC] ... ${newMessages.length} nuevos encontrados. Último ID en batch: ${currentLastId}`);
      if (newMessages.length > 2000) { console.warn('[SYNC] Límite de seguridad alcanzado (2000 msgs).'); break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (newMessages.length > 0) {
      console.log(`[SYNC] Procesando ${newMessages.length} mensajes nuevos...`);
      for (const msg of newMessages.reverse()) await processWebhookMessage(msg, activeEvent);
      await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [newestMessageIdInSync, guildId]);
      console.log(`[SYNC] ✅ Último ID procesado actualizado en DB a: ${newestMessageIdInSync}`);
    } else {
      console.log(`[SYNC] ✅ No hubo mensajes nuevos.`);
    }
  } catch (err) {
    console.error(`[SYNC] ❌ Error:`, err);
  }
}

const postRankingMessage = async () => {
  try {
    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) { console.error(`❌ Canal de Ranking no encontrado`); return; }

    if (!rankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      rankingMessage = pinned.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Ranking del Clan'));
    }

    const embed = await buildRankingEmbed(channel.guild);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh_ranking').setLabel('🔄 Actualizar ahora').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('view_full_ranking').setLabel('➡️ Ver más').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('view_event_ranking').setLabel('🏆 Ranking Evento').setStyle(ButtonStyle.Success)
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

const postEventRankingMessage = async () => {
  try {
    const guildId = process.env.GUILD_ID;
    const activeEvent = await getActiveEvent(guildId);
    if (!activeEvent) return;

    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) return;

    // Buscar mensaje de ranking de evento existente en memoria o en pineados
    if (!eventRankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      eventRankingMessage = pinned.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Ranking —'));
    }

    const embed = await buildEventRankingEmbed(channel.guild, activeEvent.id, activeEvent.nombre);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh_event_ranking').setLabel('🔄 Actualizar evento').setStyle(ButtonStyle.Success)
    );

    if (!eventRankingMessage) {
      const msg = await channel.send({ embeds: [embed], components: [row] });
      await msg.pin();
      eventRankingMessage = msg;
    } else {
      await eventRankingMessage.edit({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('❌ Error en postEventRankingMessage:', err);
  }
};

// --- Eventos del Cliente ---

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
    console.log('✅ Comandos registrados');
  } catch (error) {
    console.error('❌ Error registrando comandos:', error);
  }

  await syncRecentPoints(process.env.CHANNEL_ID, process.env.GUILD_ID);
  await postRankingMessage();

  // Si hay evento activo al iniciar, también postear su ranking
  const activeEvent = await getActiveEvent(process.env.GUILD_ID);
  if (activeEvent) await postEventRankingMessage();

  setInterval(postRankingMessage, 5 * 60 * 1000);
  setInterval(async () => {
    const ev = await getActiveEvent(process.env.GUILD_ID);
    if (ev) await postEventRankingMessage();
  }, 5 * 60 * 1000);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channel.id === process.env.CHANNEL_ID) {
    const activeEvent = await getActiveEvent(message.guild?.id);
    await processWebhookMessage(message, activeEvent);
    if (message.guild?.id) {
      try {
        await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [message.id, message.guild.id]);
      } catch (err) {
        console.error(`[MessageCreate] ❌ Error actualizando last_processed_message_id:`, err);
      }
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;

  // =============================================
  // COMANDOS SLASH
  // =============================================
  if (interaction.isChatInputCommand()) {

    // --- /ESTADISTICAS ---
    if (interaction.commandName === 'estadisticas') {
      await interaction.deferReply();
      try {
        const guildId = interaction.guild.id;
        const statsResult = await pool.query('SELECT total_puntos, temporada_nombre FROM clan_stats WHERE guild = $1', [guildId]);
        const stats = statsResult.rows[0] || { total_puntos: 0, temporada_nombre: 'Sin nombre' };

        const totalMiembros = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [guildId]);
        const mvpResult = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 1', [guildId]);
        const promedioResult = await pool.query('SELECT AVG(puntos) as promedio FROM puntos WHERE guild = $1', [guildId]);
        const totalEventos = await pool.query('SELECT COUNT(*) FROM events WHERE guild = $1', [guildId]);
        const eventoActivo = await getActiveEvent(guildId);

        const mvp = mvpResult.rows[0];
        const promedio = promedioResult.rows[0]?.promedio ? Math.round(promedioResult.rows[0].promedio) : 0;

        const embed = new EmbedBuilder()
          .setAuthor({ name: 'ESTADÍSTICAS DEL CLAN' })
          .setTitle('📊 Resumen General')
          .setColor('#3498DB')
          .setThumbnail(interaction.guild.iconURL())
          .setTimestamp()
          .addFields(
            { name: '🏆 Temporada activa', value: `\`${stats.temporada_nombre || 'Sin nombre'}\``, inline: true },
            { name: '👥 Miembros con puntos', value: `\`${totalMiembros.rows[0].count}\``, inline: true },
            { name: '⚔️ Eventos realizados', value: `\`${totalEventos.rows[0].count}\``, inline: true },
            { name: '🌟 Puntos totales del clan', value: `\`${BigInt(stats.total_puntos || 0).toLocaleString('es')} pts\``, inline: true },
            { name: '📈 Promedio por miembro', value: `\`${promedio.toLocaleString('es')} pts\``, inline: true },
            { name: '🔥 Evento activo', value: eventoActivo ? `\`${eventoActivo.nombre}\`` : '`Ninguno`', inline: true },
          );

        if (mvp) {
          embed.addFields({ name: '\u200B', value: '\u200B' });
          embed.addFields({ name: '👑 MVP del clan (general)', value: `**${mvp.usuario}** — \`${mvp.puntos.toLocaleString('es')} pts\``, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ Error al obtener estadísticas.' });
      }
    }

    // --- /INICIAR-EVENTO ---
    if (interaction.commandName === 'iniciar-evento') {
      // Verificar si ya hay evento activo
      const eventoActivo = await getActiveEvent(interaction.guild.id);
      if (eventoActivo) {
        return interaction.reply({
          content: `❌ Ya hay un evento activo: **${eventoActivo.nombre}**.\nUsá \`/cerrar-evento\` para cerrarlo antes de crear uno nuevo.`,
          flags: [MessageFlags.Ephemeral]
        });
      }

      const modal = new ModalBuilder().setCustomId('iniciar-evento-modal').setTitle('Iniciar Nuevo Evento del Clan');
      const nombreInput = new TextInputBuilder().setCustomId('nombre').setLabel('🏆 Nombre del evento').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Torneo de Navidad 2025').setRequired(true);
      const comienzoInput = new TextInputBuilder().setCustomId('comienzo').setLabel('📅 Comienzo').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Viernes 10 Nov 20:00h').setRequired(true);
      const terminaInput = new TextInputBuilder().setCustomId('termina').setLabel('📅 Termina').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Domingo 12 Nov 23:59h').setRequired(true);
      const premiosInput = new TextInputBuilder().setCustomId('premios').setLabel('🏅 Premios').setStyle(TextInputStyle.Paragraph).setPlaceholder('Ej:\n🥇 1ro: ...\n🥈 2do: ...').setRequired(true);
      const startIdInput = new TextInputBuilder().setCustomId('start_id').setLabel('📌 ID de inicio (vacío = desde ahora)').setStyle(TextInputStyle.Short).setPlaceholder('Dejar vacío para iniciar desde este momento').setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nombreInput),
        new ActionRowBuilder().addComponents(comienzoInput),
        new ActionRowBuilder().addComponents(terminaInput),
        new ActionRowBuilder().addComponents(premiosInput),
        new ActionRowBuilder().addComponents(startIdInput)
      );
      await interaction.showModal(modal);
    }

    // --- /CERRAR-EVENTO ---
    if (interaction.commandName === 'cerrar-evento') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        const guildId = interaction.guild.id;
        const activeEvent = await getActiveEvent(guildId);
        if (!activeEvent) {
          return interaction.editReply({ content: '❌ No hay ningún evento activo para cerrar.' });
        }

        // Obtener top 3 del evento
        const top3 = await pool.query(
          'SELECT usuario, puntos FROM event_points WHERE guild = $1 AND event_id = $2 ORDER BY puntos DESC LIMIT 3',
          [guildId, activeEvent.id]
        );

        // Obtener total de puntos del evento
        const totalEvento = await pool.query(
          'SELECT SUM(puntos) as total FROM event_points WHERE guild = $1 AND event_id = $2',
          [guildId, activeEvent.id]
        );
        const totalPuntos = totalEvento.rows[0]?.total || 0;

        // MVP = jugador con más puntos en el evento
        const mvp = top3.rows[0] || null;

        const medallas = ['🥇', '🥈', '🥉'];
        const podioLines = top3.rows.length > 0
          ? top3.rows.map((row, i) => `${medallas[i]} **${row.usuario}** — \`${Number(row.puntos).toLocaleString('es')} pts\``).join('\n')
          : '_Sin participantes registrados_';

        // Embed de cierre permanente
        const closingEmbed = new EmbedBuilder()
          .setAuthor({ name: '⚔️ EVENTO FINALIZADO' })
          .setTitle(`🏆 ${activeEvent.nombre}`)
          .setColor('#F1C40F')
          .setThumbnail(interaction.guild.iconURL())
          .setTimestamp()
          .addFields(
            { name: '🗓️ Período', value: `**Inicio:** ${activeEvent.fecha_inicio_texto}\n**Fin:** ${activeEvent.fecha_fin_texto}`, inline: false },
            { name: '\u200B', value: '\u200B' },
            { name: '🥇 Podio Final', value: podioLines, inline: false },
            { name: '\u200B', value: '\u200B' },
            { name: '🌟 Puntos del clan en este evento', value: `\`${Number(totalPuntos).toLocaleString('es')} pts\``, inline: true },
          );

        if (mvp) {
          closingEmbed.addFields({ name: '👑 MVP del Evento', value: `**${mvp.usuario}** con \`${Number(mvp.puntos).toLocaleString('es')} pts\``, inline: true });
        }

        // Postear en EVENTS_CHANNEL_ID
        const eventsChannel = await client.channels.fetch(process.env.EVENTS_CHANNEL_ID);
        if (eventsChannel) {
          await eventsChannel.send({ embeds: [closingEmbed] });
        } else {
          console.warn('[CERRAR-EVENTO] Canal EVENTS_CHANNEL_ID no encontrado.');
        }

        // Marcar evento como cerrado en DB
        await pool.query('UPDATE events SET status = $1, closed_at = NOW() WHERE id = $2', ['closed', activeEvent.id]);

        // Eliminar el ranking en vivo del evento si existe
        if (eventRankingMessage) {
          try { await eventRankingMessage.delete(); } catch (_) {}
          eventRankingMessage = null;
        }

        console.log(`[CERRAR-EVENTO] ✅ Evento #${activeEvent.id} "${activeEvent.nombre}" cerrado por ${interaction.user.tag}`);
        await interaction.editReply({ content: `✅ **Evento cerrado.** El podio fue publicado en <#${process.env.EVENTS_CHANNEL_ID}>.` });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ Error al cerrar el evento: ${err.message}` });
      }
    }

    // --- /EVENTO-TEMPORADA ---
    if (interaction.commandName === 'evento-temporada') {
      const modal = new ModalBuilder().setCustomId('evento-temporada-modal').setTitle('Cambiar Evento de Temporada');
      const eventoInput = new TextInputBuilder().setCustomId('evento_nombre').setLabel('🏆 Evento activo').setStyle(TextInputStyle.Short).setPlaceholder('Ej: 🎄 NAVIDAD  /  ☀️ VERANO  /  🎃 HALLOWEEN').setMaxLength(50).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(eventoInput));
      await interaction.showModal(modal);
    }

    // --- /REINICIAR-RANK ---
    if (interaction.commandName === 'reiniciar-rank') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query('TRUNCATE TABLE puntos');
        await pool.query('UPDATE clan_stats SET total_puntos = 0');
        console.log(`[RESET] ⚠️ Ranking purgado por ${interaction.user.tag}`);
        await interaction.editReply({ content: '✅ **¡Ranking reiniciado!**\nUsá `/calcular-inicio [ID]` para recontar desde un punto específico.' });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ Error crítico al reiniciar: ${err.message}` });
      }
    }

    // --- /CALCULAR-INICIO ---
    if (interaction.commandName === 'calcular-inicio') {
      const startMsgId = interaction.options.getString('message_id');
      const guildId = interaction.guild.id;
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query('UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2', [startMsgId, guildId]);
        await interaction.editReply({ content: `✅ ID establecido a ${startMsgId}. Iniciando resincronización...` });
        await syncRecentPoints(process.env.CHANNEL_ID, guildId);
        await interaction.editReply({ content: `✅ **Sincronización completada** desde el ID ${startMsgId}.` });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ Error al resetear: ${err.message}` });
      }
    }

    // --- /RANKCLAN ---
    if (interaction.commandName === 'rankclan') {
      await interaction.deferReply();
      const pageSize = 10; let currentPage = 0;
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count);
      const totalPages = Math.ceil(totalRows / pageSize) || 1;

      const fetchAndDisplay = async (page) => {
        const offset = page * pageSize;
        const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interaction.guild.id, pageSize, offset]);
        if (!result.rows.length) return interaction.editReply({ content: '⚠️ No hay puntos.' });
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} pts`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev_page_cmd').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next_page_cmd').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
        );
        await interaction.editReply({ content: `🏆 **Ranking (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n')}`, components: [row] });
      };
      await fetchAndDisplay(currentPage);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_cmd', 'next_page_cmd'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_cmd') currentPage--; else currentPage++; await i.deferUpdate(); await fetchAndDisplay(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }

    // --- /CALCULAR-EVENTO-IDS ---
    if (interaction.commandName === 'calcular-evento-ids') {
      const startId = interaction.options.getString('start_id');
      const endId = interaction.options.getString('end_id');
      await interaction.reply({ content: `⏳ Calculando evento entre ${startId} y ${endId}...`, flags: [MessageFlags.Ephemeral] });
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.messages) throw new Error('Canal no encontrado.');

        await pool.query('TRUNCATE TABLE puntos_evento_navidad');
        const messagesInRange = await fetchMessagesBetween(channel, startId, endId);
        if (messagesInRange.length === 0) return interaction.editReply({ content: '⚠️ No se encontraron mensajes.' });

        const pointsMap = new Map();
        messagesInRange.forEach(msg => {
          if (msg.webhookId && msg.embeds?.length > 0) {
            const description = msg.embeds[0].description || msg.embeds[0].title || '';
            const matchConParentesis = description.match(/\(([^)]+?) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
            const matchSinParentesis = description.match(/^[^(\n]*?!\s*([^\n(]+?) ha conseguido ([\d,.]+) puntos/sim);
            const matchUsuario = matchConParentesis || matchSinParentesis;
            if (matchUsuario) {
              const usuario = matchUsuario[1].trim();
              const puntos = parseInt(matchUsuario[2].replace(/[.,]/g, ''));
              if (!isNaN(puntos)) pointsMap.set(usuario, (pointsMap.get(usuario) || 0) + puntos);
            }
          }
        });

        if (pointsMap.size > 0) {
          const insertPromises = [];
          for (const [usuario, puntos] of pointsMap.entries()) {
            insertPromises.push(pool.query(`INSERT INTO puntos_evento_navidad (guild, usuario, puntos) VALUES ($1, $2, $3)`, [interaction.guild.id, usuario, puntos]));
          }
          await Promise.all(insertPromises);
          await interaction.editReply({ content: `✅ ¡Cálculo completado! ${pointsMap.size} usuarios guardados.` });
        } else {
          await interaction.editReply({ content: '✅ Cálculo completado, sin puntos encontrados.' });
        }
      } catch (error) {
        console.error('[EVENT CALC] Error:', error);
        await interaction.editReply({ content: `❌ Error: ${error.message}` });
      }
    }

  } // Fin isChatInputCommand()


  // =============================================
  // MODALES
  // =============================================
  if (interaction.isModalSubmit()) {

    // --- MODAL: iniciar-evento ---
    if (interaction.customId === 'iniciar-evento-modal') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        const guildId = interaction.guild.id;
        const nombre = interaction.fields.getTextInputValue('nombre').trim();
        const comienzo = interaction.fields.getTextInputValue('comienzo').trim();
        const termina = interaction.fields.getTextInputValue('termina').trim();
        const premios = interaction.fields.getTextInputValue('premios').trim();
        const startIdRaw = interaction.fields.getTextInputValue('start_id').trim();

        // Crear evento en DB
        const eventResult = await pool.query(
          `INSERT INTO events (guild, nombre, fecha_inicio_texto, fecha_fin_texto, status, created_at)
           VALUES ($1, $2, $3, $4, 'active', NOW()) RETURNING id`,
          [guildId, nombre, comienzo, termina]
        );
        const eventId = eventResult.rows[0].id;

        // Si el admin dio un ID de inicio, procesar mensajes históricos para ese evento
        if (startIdRaw && startIdRaw.length > 0) {
          await interaction.editReply({ content: `⏳ Cargando puntos históricos desde ID ${startIdRaw}...` });

          const channel = await client.channels.fetch(process.env.CHANNEL_ID);
          let messages = [];
          let currentLastId = startIdRaw;
          while (true) {
            const batch = await channel.messages.fetch({ limit: 100, after: currentLastId });
            if (batch.size === 0) break;
            batch.forEach(msg => messages.push(msg));
            currentLastId = batch.first().id;
            if (messages.length > 5000) break;
            await new Promise(r => setTimeout(r, 500));
          }

          const pointsMap = new Map();
          messages.forEach(msg => {
            if (!msg.webhookId || !msg.embeds?.length) return;
            const description = msg.embeds[0].description || msg.embeds[0].title || '';
            const matchConParentesis = description.match(/\(([^)]+?) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
            const matchSinParentesis = description.match(/^[^(\n]*?!\s*([^\n(]+?) ha conseguido ([\d,.]+) puntos/sim);
            const matchUsuario = matchConParentesis || matchSinParentesis;
            if (matchUsuario) {
              const usuario = matchUsuario[1].trim();
              const puntos = parseInt(matchUsuario[2].replace(/[.,]/g, ''));
              if (!isNaN(puntos)) pointsMap.set(usuario, (pointsMap.get(usuario) || 0) + puntos);
            }
          });

          for (const [usuario, puntos] of pointsMap.entries()) {
            await pool.query(
              `INSERT INTO event_points (guild, event_id, usuario, puntos) VALUES ($1, $2, $3, $4)
               ON CONFLICT (guild, event_id, usuario) DO UPDATE SET puntos = event_points.puntos + $4`,
              [guildId, eventId, usuario, puntos]
            );
          }
          console.log(`[INICIAR-EVENTO] ✅ ${pointsMap.size} usuarios cargados desde histórico.`);
        }

        // Embed de anuncio del evento
        const announcementEmbed = new EmbedBuilder()
          .setColor('#FF5733')
          .setTitle(`⚔️ ¡Nuevo Evento del Clan! — ${nombre}`)
          .setDescription(`@everyone\n¡Atención, Clan! ¡Se viene un nuevo evento!\nPrepárense para demostrar quién manda! 🏆`)
          .addFields(
            { name: '📅 FECHAS', value: `**Comienzo:** ${comienzo}\n**Termina:** ${termina}` },
            { name: '🏅 PREMIOS', value: premios }
          )
          .setTimestamp();

        const rankingChannel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
        if (rankingChannel) {
          await rankingChannel.send({ embeds: [announcementEmbed] });
        }

        // Postear ranking en vivo del evento
        await postEventRankingMessage();

        console.log(`[INICIAR-EVENTO] ✅ Evento #${eventId} "${nombre}" creado por ${interaction.user.tag}`);
        await interaction.editReply({ content: `✅ **¡Evento iniciado!**\nEl anuncio y el ranking en vivo fueron publicados en <#${process.env.RANKING_CHANNEL_ID}>.` });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ Error al iniciar el evento: ${err.message}` });
      }
    }

    // --- MODAL: evento-temporada ---
    if (interaction.customId === 'evento-temporada-modal') {
      const eventoNombre = interaction.fields.getTextInputValue('evento_nombre').trim();
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query(`UPDATE clan_stats SET temporada_nombre = $1 WHERE guild = $2`, [eventoNombre, interaction.guild.id]);
        const embed = await buildRankingEmbed(interaction.guild);
        if (rankingMessage) await rankingMessage.edit({ embeds: [embed] });
        await interaction.editReply({ content: `✅ Temporada actualizada: \`TEMPORADA DE CLAN | ${eventoNombre}\`` });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ Error al actualizar: ${err.message}` });
      }
    }

  } // Fin isModalSubmit()


  // =============================================
  // BOTONES
  // =============================================
  if (interaction.isButton()) {

    if (interaction.customId === 'refresh_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const embed = await buildRankingEmbed(interaction.guild);
      if (rankingMessage) { await rankingMessage.edit({ embeds: [embed] }); await interaction.editReply({ content: '✅ Ranking actualizado.' }); }
      else await interaction.editReply({ content: '❌ No se pudo encontrar el mensaje.' });
      return;
    }

    if (interaction.customId === 'refresh_event_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const activeEvent = await getActiveEvent(interaction.guild.id);
      if (!activeEvent) return interaction.editReply({ content: '❌ No hay evento activo.' });
      const embed = await buildEventRankingEmbed(interaction.guild, activeEvent.id, activeEvent.nombre);
      if (eventRankingMessage) { await eventRankingMessage.edit({ embeds: [embed] }); await interaction.editReply({ content: '✅ Ranking del evento actualizado.' }); }
      else await interaction.editReply({ content: '❌ No se pudo encontrar el mensaje del evento.' });
      return;
    }

    if (interaction.customId === 'view_full_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count);
      const totalPages = Math.ceil(totalRows / pageSize) || 1;

      const displayPage = async (page) => {
        const offset = page * pageSize;
        const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interaction.guild.id, pageSize, offset]);
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev_page_full').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next_page_full').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        await interaction.editReply({ content: `🏆 **Ranking completo (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
      };
      await displayPage(currentPage);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_full', 'next_page_full'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_full') currentPage--; else currentPage++; await i.deferUpdate(); await displayPage(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    if (interaction.customId === 'view_event_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      const activeEvent = await getActiveEvent(interaction.guild.id);

      if (!activeEvent) {
        // Fallback a tabla legacy puntos_evento_navidad
        const totalResult = await pool.query('SELECT COUNT(*) FROM puntos_evento_navidad WHERE guild = $1', [interaction.guild.id]);
        const totalRows = parseInt(totalResult.rows[0].count);
        const totalPages = Math.ceil(totalRows / pageSize) || 1;

        const displayEventPage = async (page) => {
          const offset = page * pageSize;
          const result = await pool.query('SELECT usuario, puntos FROM puntos_evento_navidad WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interaction.guild.id, pageSize, offset]);
          const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prev_page_event').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('next_page_event').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
          );
          await interaction.editReply({ content: `🏆 **Ranking Evento (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
        };
        await displayEventPage(currentPage);
        const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_event', 'next_page_event'].includes(i.customId), time: 60_000 });
        collector.on('collect', async i => { if (i.customId === 'prev_page_event') currentPage--; else currentPage++; await i.deferUpdate(); await displayEventPage(currentPage); });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
        return;
      }

      const totalResult = await pool.query('SELECT COUNT(*) FROM event_points WHERE guild = $1 AND event_id = $2', [interaction.guild.id, activeEvent.id]);
      const totalRows = parseInt(totalResult.rows[0].count);
      const totalPages = Math.ceil(totalRows / pageSize) || 1;

      const displayEventPage = async (page) => {
        const offset = page * pageSize;
        const result = await pool.query('SELECT usuario, puntos FROM event_points WHERE guild = $1 AND event_id = $2 ORDER BY puntos DESC LIMIT $3 OFFSET $4', [interaction.guild.id, activeEvent.id, pageSize, offset]);
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev_page_event').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next_page_event').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        await interaction.editReply({ content: `🏆 **${activeEvent.nombre} (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
      };
      await displayEventPage(currentPage);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_event', 'next_page_event'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_event') currentPage--; else currentPage++; await i.deferUpdate(); await displayEventPage(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

  } // Fin isButton()

});


// ==========================================
// INICIO DEL BOT
// ==========================================
(async () => {
  try {
    console.log('Conectando a la base de datos...');

    // Tablas originales
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos" lista');

    await pool.query(`CREATE TABLE IF NOT EXISTS clan_stats (guild TEXT PRIMARY KEY, total_puntos BIGINT DEFAULT 0, last_processed_message_id TEXT)`);
    console.log('✅ Tabla "clan_stats" lista');

    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS paquetes_tienda INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS last_processed_message_id TEXT`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS temporada_nombre TEXT`);
    console.log('✅ Columnas aseguradas en clan_stats');

    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_evento_navidad (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos_evento_navidad" lista (legacy)');

    // Nuevas tablas para el sistema de eventos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        guild TEXT NOT NULL,
        nombre TEXT NOT NULL,
        fecha_inicio_texto TEXT,
        fecha_fin_texto TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP
      )
    `);
    console.log('✅ Tabla "events" lista');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_points (
        guild TEXT NOT NULL,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        usuario TEXT NOT NULL,
        puntos INTEGER DEFAULT 0,
        PRIMARY KEY (guild, event_id, usuario)
      )
    `);
    console.log('✅ Tabla "event_points" lista');

    // Asegurar fila inicial en clan_stats para este guild
    await pool.query(`INSERT INTO clan_stats (guild) VALUES ($1) ON CONFLICT (guild) DO NOTHING`, [process.env.GUILD_ID]);
    console.log('✅ Fila clan_stats asegurada');

    console.log('Iniciando sesión en Discord...');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Error fatal durante el inicio:', err);
    process.exit(1);
  }
})();
