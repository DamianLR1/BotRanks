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
  MessageFlags,
  PermissionsBitField // Necesario para el comando de admin
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

// --- Funciones de Ayuda ---

function createProgressBar(value, maxValue, size = 10) {
  if (value <= 0 || maxValue <= 0) return '`[          ]`';
  const percentage = value / maxValue;
  const progress = Math.round(size * percentage);
  const filled = '█';
  const empty = '░';
  return `\`[${filled.repeat(progress)}${empty.repeat(size - progress)}]\``;
}

/**
 * Obtiene mensajes entre dos IDs específicos (más nuevos primero).
 * NOTA: Discord API no soporta "between", así que leemos "after" start y paramos en end.
 */
async function fetchMessagesBetween(channel, startId, endId) {
  let allMessages = [];
  let lastId = startId; // Empezamos a buscar DESPUÉS del mensaje inicial del evento

  console.log(`[fetchMessagesBetween] Buscando mensajes DESPUÉS de ${startId} hasta ANTES o IGUAL a ${endId}`);

  try {
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after: lastId });

      if (messages.size === 0) {
        console.log(`[fetchMessagesBetween] No se encontraron más mensajes después de ${lastId}.`);
        break; // No hay más mensajes nuevos
      }

      let reachedEnd = false;
      messages.forEach(msg => {
        // Comparamos IDs como BigInts para evitar problemas con números grandes
        if (BigInt(msg.id) <= BigInt(endId)) {
          allMessages.push(msg); // Añadimos el mensaje si está dentro del rango
        } else {
          // Si un mensaje es MÁS NUEVO que endId, paramos
          console.log(`[fetchMessagesBetween] Mensaje ${msg.id} es más nuevo que ${endId}. Deteniendo batch.`);
          reachedEnd = true;
        }
      });

      lastId = messages.first().id; // El ID más nuevo para la siguiente búsqueda 'after'

      console.log(`[fetchMessagesBetween] ... ${allMessages.length} mensajes recopilados. Último ID procesado: ${lastId}`);

      if (reachedEnd) {
          console.log(`[fetchMessagesBetween] Se alcanzó o superó el ID final (${endId}). Deteniendo búsqueda.`);
          break; // Salimos del while si encontramos mensajes más allá del final
      }

      // Parada de seguridad por si algo va mal
      if (allMessages.length > 10000) { // Limita a 10k mensajes por si acaso
          console.warn('[fetchMessagesBetween] Límite de seguridad de 10k mensajes alcanzado.');
          break;
      }

      await new Promise(resolve => setTimeout(resolve, 500)); // Pausa
    }
  } catch (error) {
      console.error('[fetchMessagesBetween] Error al buscar mensajes:', error);
      // Devuelve lo que se haya podido recopilar
  }

  console.log(`[fetchMessagesBetween] Finalizado. Total de mensajes en rango: ${allMessages.length}`);
  return allMessages; // Devuelve los mensajes ordenados de más nuevo a más viejo
}

// --- Configuración de Base de Datos y Cliente Discord ---

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE, port: process.env.PGPORT, ssl: { rejectUnauthorized: false }
});

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ],
  partials: [Partials.Channel],
});

// --- Comandos Slash ---

const commands = [
  new SlashCommandBuilder()
    .setName('rankclan')
    .setDescription('Muestra el ranking de los miembros con más puntos')
    .toJSON(),
  // ¡NUEVO COMANDO DE ADMIN!
  new SlashCommandBuilder()
    .setName('calcular-evento-ids')
    .setDescription('[Admin] Calcula el ranking del evento basado en IDs de mensaje.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // Solo Admins
    .addStringOption(option => option.setName('start_id').setDescription('ID del primer mensaje del evento').setRequired(true))
    .addStringOption(option => option.setName('end_id').setDescription('ID del último mensaje del evento').setRequired(true))
    .toJSON(),
];

let rankingMessage = null;

// --- Funciones Principales del Bot ---

async function buildRankingEmbed(guild) {
  const resultUsuarios = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10', [guild.id]);
  const resultStats = await pool.query('SELECT total_puntos, paquetes_tienda FROM clan_stats WHERE guild = $1', [guild.id]);
  const stats = resultStats.rows[0] || { total_puntos: '0', paquetes_tienda: 0 };
  const topPoints = resultUsuarios.rows.length ? resultUsuarios.rows[0].puntos : 0;

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'TEMPORADA DE CLANES 🎃 HALLOWEEN' })
    .setTitle('➥ 🏆 Ranking del Clan')
    .setDescription('\u200B')
    .setColor('#E67E22')
    .setImage(guild.iconURL())
    .setTimestamp();

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
    embed.addFields(
      { name: 'Total del Clan', value: `**\`${BigInt(stats.total_puntos).toLocaleString('es')} pts\`**`, inline: true },
      { name: 'Paquetes de tienda', value: `**\`${stats.paquetes_tienda}\`**`, inline: true }
    );
  }
  return embed;
}

async function backfillStorePackages(channelId, guildId) {
    // ... (La función de escaneo de paquetes sigue igual, con los límites)
    try {
        console.log(`[HISTÓRICO] 🚀 Iniciando escaneo de 'Tienda de Almas' en el canal ${channelId}...`);
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) { console.error(`[HISTÓRICO] ❌ Canal no encontrado o sin permisos.`); return; }

        let totalCount = 0; let lastId; let messagesFetched = 0;
        const batchSize = 100; const maxPackagesToFind = 115; const maxStaleMessages = 500;
        let messagesSinceLastFind = 0;

        console.log(`[HISTÓRICO] Buscando (Max: ${maxPackagesToFind} paquetes, Parar tras ${maxStaleMessages} mensajes sin encontrar)...`);

        while (true) {
            const options = { limit: batchSize }; if (lastId) options.before = lastId;
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) { console.log(`[HISTÓRICO] Fin del historial.`); break; }

            let foundInThisBatch = false;
            messages.every(message => {
                if (message.webhookId && message.embeds?.length > 0) {
                    const description = message.embeds[0].description || message.embeds[0].title || '';
                    if (description.match(/Tienda de Almas/i)) { totalCount++; foundInThisBatch = true; }
                }
                if (totalCount >= maxPackagesToFind) return false;
                return true;
            });

            messagesFetched += messages.size; lastId = messages.last().id;
            console.log(`[HISTÓRICO] ... ${messagesFetched} revisados, ${totalCount} encontrados...`);

            if (totalCount >= maxPackagesToFind) { console.log(`[HISTÓRICO] Límite de ${maxPackagesToFind} paquetes alcanzado.`); break; }
            if (foundInThisBatch) messagesSinceLastFind = 0; else messagesSinceLastFind += messages.size;
            if (messagesSinceLastFind >= maxStaleMessages) { console.log(`[HISTÓRICO] Límite de ${maxStaleMessages} mensajes sin encontrar alcanzado.`); break; }

            await new Promise(resolve => setTimeout(resolve, 500));
        }
        console.log(`[HISTÓRICO] ✅ Escaneo completado. Total: ${totalCount}`);
        await pool.query(`INSERT INTO clan_stats (guild, paquetes_tienda) VALUES ($1, $2) ON CONFLICT (guild) DO UPDATE SET paquetes_tienda = $2`, [guildId, totalCount]);
        console.log(`[HISTÓRICO] ✅ DB actualizada.`);
    } catch (err) { console.error(`[HISTÓRICO] ❌ Error:`, err); if (err.code === 50013) console.error(`[HISTÓRICO] ❌ Sin permiso para leer historial.`); }
}

/**
 * Procesa un solo mensaje de webhook para extraer y guardar puntos.
 * Reutilizamos esta lógica para el sync y para mensajes nuevos.
 */
async function processWebhookMessage(message) {
    if (!message.guild?.id || !message.webhookId || !message.embeds?.length > 0) return;

    const embed = message.embeds[0];
    const description = embed.description || embed.title || '';
    const guildId = message.guild.id;

    // --- ACCIÓN 1: PUNTOS DE USUARIO (SUMA) ---
    const matchUsuario = description.match(/\(([^)]+) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
    if (matchUsuario) {
        const usuario = matchUsuario[1].trim();
        const puntosStr = matchUsuario[2];
        const puntosLimpio = puntosStr.replace(/[.,]/g, '');
        const puntos = parseInt(puntosLimpio);

        if (!isNaN(puntos)) {
            try {
                await pool.query(`
                  INSERT INTO puntos (guild, usuario, puntos) VALUES ($1, $2, $3)
                  ON CONFLICT (guild, usuario) DO UPDATE SET puntos = puntos.puntos + $3`,
                  [guildId, usuario, puntos]
                );
                console.log(`[PROCESS] 🟢 ${usuario} ganó ${puntos} puntos (Mensaje ID: ${message.id})`);
            } catch (err) {
                console.error(`[PROCESS] ❌ Error al guardar puntos para ${usuario}:`, err);
            }
        } else {
             console.error(`[PROCESS] [ERROR] No se pudo convertir "${puntosStr}" a número (Mensaje ID: ${message.id})`);
        }
    }

    // --- ACCIÓN 2: TOTAL DEL CLAN (SOBRESCRIBE) ---
    const matchTotal = description.match(/ahora tiene\s+([0-9,.]+)\s+puntos de experiencia/si);
    if (matchTotal) {
        const totalPuntos = BigInt(matchTotal[1].replace(/[,.]/g, ''));
        try {
            await pool.query(`
              INSERT INTO clan_stats (guild, total_puntos) VALUES ($1, $2)
              ON CONFLICT (guild) DO UPDATE SET total_puntos = $2`,
              [guildId, totalPuntos]
            );
             console.log(`[PROCESS] 🔵 Total actualizado: ${totalPuntos} (Mensaje ID: ${message.id})`);
        } catch (err) {
            console.error('[PROCESS] ❌ Error al guardar puntos totales:', err);
        }
    }

    // --- ACCIÓN 3: PAQUETES DE TIENDA (SUMA 1) ---
    const matchTienda = description.match(/Tienda de Almas/i);
    if (matchTienda) {
         try {
            await pool.query(`
              INSERT INTO clan_stats (guild, paquetes_tienda) VALUES ($1, 1)
              ON CONFLICT (guild) DO UPDATE SET paquetes_tienda = clan_stats.paquetes_tienda + 1`,
              [guildId]
            );
            console.log(`[PROCESS] 📦 Paquete de tienda detectado! (Mensaje ID: ${message.id})`);
        } catch (err) {
            console.error('[PROCESS] ❌ Error al guardar paquete de tienda:', err);
        }
    }
}

/**
 * Busca y procesa mensajes nuevos desde el último mensaje conocido.
 */
async function syncRecentPoints(channelId, guildId) {
    console.log(`[SYNC] 🚀 Iniciando sincronización de puntos recientes...`);
    let lastProcessedId = process.env.RESET_MESSAGE_ID; // ID de la variable de entorno como punto de partida

    try {
        // Intentamos obtener el ID MÁS RECIENTE guardado en la DB
        const result = await pool.query('SELECT last_processed_message_id FROM clan_stats WHERE guild = $1', [guildId]);
        if (result.rows.length > 0 && result.rows[0].last_processed_message_id) {
            lastProcessedId = result.rows[0].last_processed_message_id;
            console.log(`[SYNC] Último ID procesado encontrado en DB: ${lastProcessedId}`);
        } else {
            console.log(`[SYNC] No se encontró ID en DB, usando RESET_MESSAGE_ID: ${lastProcessedId}`);
        }

        if (!lastProcessedId) {
            console.warn('[SYNC] ⚠️ No hay RESET_MESSAGE_ID definido ni ID guardado. No se puede sincronizar.');
            return;
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) {
            console.error(`[SYNC] ❌ Canal ${channelId} no encontrado o sin permisos.`);
            return;
        }

        let newMessages = [];
        let currentLastId = lastProcessedId;
        let newestMessageIdInSync = lastProcessedId; // Guardará el ID del mensaje más nuevo procesado en esta sync

        console.log(`[SYNC] Buscando mensajes NUEVOS después de ${currentLastId}...`);

        while (true) {
            // Buscamos mensajes DESPUÉS del último conocido
            const messages = await channel.messages.fetch({ limit: 100, after: currentLastId });

            if (messages.size === 0) {
                console.log(`[SYNC] No se encontraron mensajes más nuevos.`);
                break; // No hay más mensajes nuevos
            }

            // Los mensajes vienen del más viejo al más nuevo cuando usamos 'after'
            messages.forEach(msg => {
                newMessages.push(msg);
                // Actualizamos el ID del mensaje más nuevo encontrado hasta ahora
                if (BigInt(msg.id) > BigInt(newestMessageIdInSync)) {
                    newestMessageIdInSync = msg.id;
                }
            });

            // El 'lastId' para la siguiente búsqueda 'after' es el ID más nuevo de este batch
            currentLastId = messages.first().id;

            console.log(`[SYNC] ... ${newMessages.length} mensajes nuevos encontrados. Último ID en batch: ${currentLastId}`);

            // Parada de seguridad
            if (newMessages.length > 1000) {
                console.warn('[SYNC] Límite de seguridad de 1000 mensajes nuevos alcanzado.');
                break;
            }
             await new Promise(resolve => setTimeout(resolve, 500)); // Pausa
        }

        if (newMessages.length > 0) {
            console.log(`[SYNC] Procesando ${newMessages.length} mensajes nuevos...`);
            // Procesamos los mensajes del más viejo al más nuevo para mantener el orden
            for (const msg of newMessages.reverse()) {
                await processWebhookMessage(msg); // Reutilizamos la lógica principal
            }

            // Guardamos el ID del mensaje MÁS NUEVO procesado en esta sincronización
            await pool.query(
                `UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`,
                [newestMessageIdInSync, guildId]
            );
            console.log(`[SYNC] ✅ Último ID procesado actualizado en DB a: ${newestMessageIdInSync}`);

        } else {
            console.log(`[SYNC] ✅ No hubo mensajes nuevos que procesar.`);
        }

    } catch (err) {
        console.error(`[SYNC] ❌ Error durante la sincronización:`, err);
    }
}


const postRankingMessage = async () => {
  try {
    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) { console.error(`❌ Canal de Ranking no encontrado`); return; }

    if (!rankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      rankingMessage = pinned.find(m => m.author.id === client.user.id);
    }

    const embed = await buildRankingEmbed(channel.guild);

    // ¡BOTÓN NUEVO AÑADIDO!
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh_ranking').setLabel('🔄 Actualizar ahora').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('view_full_ranking').setLabel('➡️ Ver más').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('view_event_ranking').setLabel('🏆 Ranking Evento').setStyle(ButtonStyle.Success) // ¡Nuevo Botón!
    );

    if (!rankingMessage) {
      const msg = await channel.send({ embeds: [embed], components: [row] });
      await msg.pin(); rankingMessage = msg;
    } else {
      await rankingMessage.edit({ embeds: [embed], components: [row] });
    }
  } catch (err) { console.error('❌ Error en postRankingMessage:', err); }
};


// --- Eventos del Cliente ---

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    // Registramos TODOS los comandos
    await rest.put( Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands } );
    console.log('✅ Comandos registrados');
  } catch (error) { console.error('❌ Error registrando comandos:', error); }

  // 1. Escanea paquetes históricos
  await backfillStorePackages(process.env.CHANNER_ID, process.env.GUILD_ID);

  // 2. Sincroniza puntos desde el último reinicio/reset
  await syncRecentPoints(process.env.CHANNER_ID, process.env.GUILD_ID);

  // 3. Publica/actualiza el ranking principal y empieza el ciclo
  await postRankingMessage();
  setInterval(postRankingMessage, 5 * 60 * 1000);
});


client.on(Events.MessageCreate, async (message) => {
  // Solo procesa mensajes del canal de webhook
  if (message.channel.id === process.env.CHANNER_ID) {
    await processWebhookMessage(message); // Usa la función reutilizable
    // Actualizamos el último ID procesado después de CADA mensaje nuevo
    if (message.guild?.id) {
       try {
           await pool.query(
               `UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`,
               [message.id, message.guild.id]
           );
       } catch(err) {
            console.error(`[MessageCreate] ❌ Error actualizando last_processed_message_id a ${message.id}:`, err);
       }
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;

  // --- Lógica de Botones ---
  if (interaction.isButton()) {
    // Botón "Actualizar ahora"
    if (interaction.customId === 'refresh_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const embed = await buildRankingEmbed(interaction.guild);
      if (rankingMessage) {
        await rankingMessage.edit({ embeds: [embed] });
        await interaction.editReply({ content: '✅ Ranking actualizado.' });
      } else { await interaction.editReply({ content: '❌ No se pudo encontrar el mensaje de ranking.' }); }
      return;
    }

    // Botón "Ver más" (Ranking Completo Actual)
    if (interaction.customId === 'view_full_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;

      const displayPage = async (page, interactionRef) => { /* ... Lógica de paginación ... */
          const offset = page * pageSize;
          const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interactionRef.guild.id, pageSize, offset]);
          const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
          const row = new ActionRowBuilder().addComponents( /* ... Botones Prev/Next ... */
              new ButtonBuilder().setCustomId('prev_page_full').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId('next_page_full').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
          );
          await interactionRef.editReply({ content: `🏆 **Ranking completo (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
      };
      await displayPage(currentPage, interaction);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_full', 'next_page_full'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_full') currentPage--; if (i.customId === 'next_page_full') currentPage++; await i.deferUpdate(); await displayPage(currentPage, interaction); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    // ¡NUEVO BOTÓN! "Ranking Evento"
    if (interaction.customId === 'view_event_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      // Consultamos la tabla del evento
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos_evento_halloween WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;

      const displayEventPage = async (page, interactionRef) => {
          const offset = page * pageSize;
          // Consultamos la tabla del evento
          const result = await pool.query('SELECT usuario, puntos FROM puntos_evento_halloween WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interactionRef.guild.id, pageSize, offset]);
          const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
          const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('prev_page_event').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId('next_page_event').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
          );
          await interactionRef.editReply({ content: `🎃 **Ranking Evento Halloween (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
      };
      await displayEventPage(currentPage, interaction);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_event', 'next_page_event'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_event') currentPage--; if (i.customId === 'next_page_event') currentPage++; await i.deferUpdate(); await displayEventPage(currentPage, interaction); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }
  } // Fin de isButton()

  // --- Lógica de Comandos Slash ---
  if (interaction.isChatInputCommand()) {
    // Comando /rankclan (Paginación normal)
    if (interaction.commandName === 'rankclan') {
        await interaction.deferReply();
        const pageSize = 10; let currentPage = 0;
        const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
        const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;
        const fetchAndDisplay = async (page) => { /* ... Lógica de paginación del comando /rankclan ... */
            try {
                const offset = page * pageSize;
                const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interaction.guild.id, pageSize, offset]);
                if (!result.rows.length) return interaction.editReply({ content: '⚠️ No hay puntos.' });
                const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} pts`);
                const row = new ActionRowBuilder().addComponents( /* ... Botones Prev/Next ... */
                     new ButtonBuilder().setCustomId('prev_page_cmd').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
                     new ButtonBuilder().setCustomId('next_page_cmd').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
                );
                await interaction.editReply({ content: `🏆 **Ranking (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n')}`, components: [row] });
            } catch (err) { console.error(err); if (interaction.replied || interaction.deferred) await interaction.editReply({ content: '❌ Error.', components: [] });}
        };
        await fetchAndDisplay(currentPage);
        const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_cmd', 'next_page_cmd'].includes(i.customId), time: 60_000 });
        collector.on('collect', async i => { if (i.customId === 'prev_page_cmd') currentPage--; if (i.customId === 'next_page_cmd') currentPage++; await i.deferUpdate(); await fetchAndDisplay(currentPage); });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }

    // ¡NUEVO COMANDO! /calcular-evento-ids
    if (interaction.commandName === 'calcular-evento-ids') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: '❌ No tienes permisos para usar este comando.', flags: [MessageFlags.Ephemeral] });
      }

      const startId = interaction.options.getString('start_id');
      const endId = interaction.options.getString('end_id');
      const channelId = process.env.CHANNER_ID; // Canal del webhook

      await interaction.reply({ content: `⏳ Calculando puntos del evento entre mensajes ${startId} y ${endId}. Esto puede tardar varios minutos...`, flags: [MessageFlags.Ephemeral] });

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) throw new Error('Canal no encontrado o sin permisos.');

        // 1. Borrar tabla histórica (TRUNCATE es más rápido que DELETE)
        await pool.query('TRUNCATE TABLE puntos_evento_halloween');
        console.log('[EVENT CALC] Tabla puntos_evento_halloween vaciada.');

        // 2. Obtener mensajes en el rango
        const messagesInRange = await fetchMessagesBetween(channel, startId, endId);

        if (messagesInRange.length === 0) {
           return interaction.editReply({ content: '⚠️ No se encontraron mensajes en el rango especificado.' });
        }

        // 3. Calcular puntos (en memoria)
        const pointsMap = new Map(); // Mapa para acumular puntos por usuario

        messagesInRange.forEach(msg => {
          if (msg.webhookId && msg.embeds?.length > 0) {
            const description = msg.embeds[0].description || msg.embeds[0].title || '';
            const matchUsuario = description.match(/\(([^)]+) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
            if (matchUsuario) {
              const usuario = matchUsuario[1].trim();
              const puntosStr = matchUsuario[2];
              const puntosLimpio = puntosStr.replace(/[.,]/g, '');
              const puntos = parseInt(puntosLimpio);

              if (!isNaN(puntos)) {
                const currentPoints = pointsMap.get(usuario) || 0;
                pointsMap.set(usuario, currentPoints + puntos);
              }
            }
          }
        });

        // 4. Guardar en la base de datos
        if (pointsMap.size > 0) {
          const insertPromises = [];
          for (const [usuario, puntos] of pointsMap.entries()) {
            insertPromises.push(pool.query(
              `INSERT INTO puntos_evento_halloween (guild, usuario, puntos) VALUES ($1, $2, $3)`,
              [interaction.guild.id, usuario, puntos]
            ));
          }
          await Promise.all(insertPromises); // Ejecuta todas las inserciones
          console.log(`[EVENT CALC] ${pointsMap.size} usuarios guardados en puntos_evento_halloween.`);
          await interaction.editReply({ content: `✅ ¡Cálculo completado! Se guardaron los puntos de ${pointsMap.size} usuarios para el evento.` });
        } else {
          await interaction.editReply({ content: '✅ Cálculo completado, pero no se encontraron puntos de usuario en los mensajes del evento.' });
        }

      } catch (error) {
        console.error('[EVENT CALC] Error calculando el evento:', error);
        await interaction.editReply({ content: `❌ Ocurrió un error al calcular: ${error.message}` });
      }
    }
  } // Fin de isChatInputCommand()
});


// --- INICIO DEL BOT ---
(async () => {
  try {
    console.log('Conectando a la base de datos...');
    
    // Tabla Puntos (Actual)
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos" lista');

    // Tabla Stats (Total, Paquetes, Último ID)
    await pool.query(`CREATE TABLE IF NOT EXISTS clan_stats (guild TEXT PRIMARY KEY, total_puntos BIGINT DEFAULT 0, paquetes_tienda INTEGER DEFAULT 0, last_processed_message_id TEXT)`);
    console.log('✅ Tabla "clan_stats" lista');
    // Asegurar columnas por si la tabla ya existía
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS paquetes_tienda INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS last_processed_message_id TEXT`);
    console.log('✅ Columnas "paquetes_tienda" y "last_processed_message_id" aseguradas en clan_stats');

    // ¡NUEVA TABLA HISTÓRICA!
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_evento_halloween (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos_evento_halloween" lista');

    console.log('Iniciando sesión en Discord...');
    await client.login(process.env.DISCORD_TOKEN);

  } catch (err) { console.error('❌ Error fatal durante el inicio:', err); process.exit(1); }
})();
