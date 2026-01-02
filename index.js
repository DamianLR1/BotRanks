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
            messages.forEach(msg => { if (BigInt(msg.id) <= BigInt(endId)) allMessages.push(msg); else reachedEnd = true; });
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
  new SlashCommandBuilder()
    .setName('crear-evento')
    .setDescription('[Admin] Crea un anuncio para un nuevo evento del clan.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('calcular-evento-ids')
    .setDescription('[Admin] Calcula el ranking del evento basado en IDs de mensaje.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(option => option.setName('start_id').setDescription('ID del primer mensaje del evento').setRequired(true))
    .addStringOption(option => option.setName('end_id').setDescription('ID del último mensaje del evento').setRequired(true))
    .toJSON(),
  // --- NUEVO COMANDO AÑADIDO (Mantenido) ---
  new SlashCommandBuilder()
    .setName('calcular-inicio')
    .setDescription('[Admin] Resetea el rastreo desde un ID anterior y sincroniza los puntos perdidos.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(option => option.setName('message_id').setDescription('ID del mensaje DESDE donde empezar a contar (exclusivo)').setRequired(true))
    .toJSON(),
];

let rankingMessage = null;

// --- Funciones Principales ---

async function buildRankingEmbed(guild) {
    const resultUsuarios = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10', [guild.id]);
    const resultStats = await pool.query('SELECT total_puntos FROM clan_stats WHERE guild = $1', [guild.id]);
    const stats = resultStats.rows[0] || { total_puntos: '0' };
    const topPoints = resultUsuarios.rows.length ? resultUsuarios.rows[0].puntos : 0;
    
    const embed = new EmbedBuilder()
        .setAuthor({ name: 'TEMPORADA DE CLAN | 🎄 NAVIDAD' })
        .setTitle('➥ 🏆 Ranking del Clan')
        .setDescription('\u200B')
        .setColor('#E67E22').setImage(guild.iconURL()).setTimestamp();
    
    if (resultUsuarios.rows.length === 0) { embed.setDescription('No hay datos aún.'); }
    else {
        const medallas = ['🥇', '🥈', '🥉'];
        const rankingLines = resultUsuarios.rows.map((row, i) => {
            const rank = medallas[i] || `**${i + 1}.**`;
            return `${rank} **${row.usuario}**\n   \`${row.puntos} pts\` ${createProgressBar(row.puntos, topPoints, 10)}`;
        }).join('\n\n');
        embed.addFields({ name: '➥ Ranking de Miembros', value: rankingLines, inline: false });
        embed.addFields({ name: '\u200B', value: '\u200B', inline: false });
        
        embed.addFields(
            { name: 'Total del Clan', value: `**\`${BigInt(stats.total_puntos).toLocaleString('es')} pts\`**`, inline: true }
        );
    } return embed;
}

// (Función backfillStorePackages ELIMINADA por completo)

async function processWebhookMessage(message) {
    if (!message.guild?.id || !message.webhookId || !message.embeds?.length > 0) return;
    const embed = message.embeds[0];
    const description = embed.description || embed.title || ''; 
    const guildId = message.guild.id;

    // Detectar Puntos de Usuario
    const matchUsuario = description.match(/\(([^)]+) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
    if (matchUsuario) {
        const usuario = matchUsuario[1].trim();
        const puntosStr = matchUsuario[2];
        const puntosLimpio = puntosStr.replace(/[.,]/g, ''); 
        const puntos = parseInt(puntosLimpio);
        
        if (!isNaN(puntos)) {
            try { 
                await pool.query(`INSERT INTO puntos (guild, usuario, puntos) VALUES ($1, $2, $3) ON CONFLICT (guild, usuario) DO UPDATE SET puntos = puntos.puntos + $3`, [guildId, usuario, puntos]);
                console.log(`[PROCESS] 🟢 ${usuario} ganó ${puntos} puntos (ID: ${message.id})`); 
            }
            catch (err) { console.error(`[PROCESS] ❌ Error al guardar puntos para ${usuario}:`, err); }
        } else { 
            console.error(`[PROCESS] [ERROR] No se pudo convertir "${puntosStr}" a número (ID: ${message.id})`);
        }
    } 

    // Detectar Puntos Totales del Clan
    const matchTotal = description.match(/ahora tiene\s+([0-9,.]+)\s+puntos de experiencia/si);
    if (matchTotal) {
        const totalPuntos = BigInt(matchTotal[1].replace(/[,.]/g, ''));
        try { 
            await pool.query(`INSERT INTO clan_stats (guild, total_puntos) VALUES ($1, $2) ON CONFLICT (guild) DO UPDATE SET total_puntos = $2`, [guildId, totalPuntos]);
            console.log(`[PROCESS] 🔵 Total actualizado: ${totalPuntos} (ID: ${message.id})`); 
        }
        catch (err) { console.error('[PROCESS] ❌ Error al guardar puntos totales:', err); }
    }
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
            for (const msg of newMessages.reverse()) await processWebhookMessage(msg);
            
            await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [newestMessageIdInSync, guildId]);
            console.log(`[SYNC] ✅ Último ID procesado actualizado en DB a: ${newestMessageIdInSync}`);
        } else console.log(`[SYNC] ✅ No hubo mensajes nuevos.`);
    } catch (err) { console.error(`[SYNC] ❌ Error:`, err); }
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
  } catch (err) { console.error('❌ Error en postRankingMessage:', err); }
};

// --- Eventos del Cliente ---

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put( Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands } );
    console.log('✅ Comandos registrados');
  } catch (error) { console.error('❌ Error registrando comandos:', error); }

  await syncRecentPoints(process.env.CHANNER_ID, process.env.GUILD_ID);
  await postRankingMessage();
  setInterval(postRankingMessage, 5 * 60 * 1000);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channel.id === process.env.CHANNER_ID) {
    await processWebhookMessage(message);
    if (message.guild?.id) {
       try { await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [message.id, message.guild.id]); }
       catch(err) { console.error(`[MessageCreate] ❌ Error actualizando last_processed_message_id a ${message.id}:`, err); }
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;

  // --- Lógica de Comandos Slash ---
  if (interaction.isChatInputCommand()) {
    
    // --- Lógica del nuevo comando /calcular-inicio ---
    if (interaction.commandName === 'calcular-inicio') {
        const startMsgId = interaction.options.getString('message_id');
        const guildId = interaction.guild.id;
        
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        try {
            await pool.query('UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2', [startMsgId, guildId]);
            console.log(`[MANUAL RESET] ID reseteado a ${startMsgId} por ${interaction.user.tag}`);
            
            await interaction.editReply({ content: `✅ ID establecido a ${startMsgId}. Iniciando resincronización... (Esto puede tardar unos segundos)` });
            
            await syncRecentPoints(process.env.CHANNER_ID, guildId);
            
            await interaction.editReply({ content: `✅ **Sincronización completada.** El bot ha releído los mensajes desde el ID ${startMsgId} hasta ahora.` });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: `❌ Error al resetear: ${err.message}` });
        }
    }
    // ------------------------------------------------

    // Comando /rankclan
    if (interaction.commandName === 'rankclan') {
        await interaction.deferReply(); const pageSize = 10; let currentPage = 0;
        const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
        const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;
        const fetchAndDisplay = async (page) => { 
            try { 
                const offset = page * pageSize; 
                const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interaction.guild.id, pageSize, offset]); 
                if (!result.rows.length) return interaction.editReply({ content: '⚠️ No hay puntos.' }); 
                const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} pts`);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('prev_page_cmd').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(page === 0), 
                    new ButtonBuilder().setCustomId('next_page_cmd').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
                );
                await interaction.editReply({ content: `🏆 **Ranking (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n')}`, components: [row] }); 
            } catch (err) { 
                console.error(err);
                if (interaction.replied || interaction.deferred) await interaction.editReply({ content: '❌ Error.', components: [] });
            }
        };
        await fetchAndDisplay(currentPage);
        const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_cmd', 'next_page_cmd'].includes(i.customId), time: 60_000 });
        collector.on('collect', async i => { if (i.customId === 'prev_page_cmd') currentPage--; if (i.customId === 'next_page_cmd') currentPage++; await i.deferUpdate(); await fetchAndDisplay(currentPage); });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }

    // Comando /crear-evento
    if (interaction.commandName === 'crear-evento') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: '❌ Solo admins.', flags: [MessageFlags.Ephemeral] });
      }
      const modal = new ModalBuilder().setCustomId('evento-modal').setTitle('Crear Nuevo Evento del Clan');
      const comienzoInput = new TextInputBuilder().setCustomId('comienzo').setLabel("📅 Comienzo").setStyle(TextInputStyle.Short).setPlaceholder('Ej: Viernes 10 Nov 20:00h').setRequired(true);
      const terminaInput = new TextInputBuilder().setCustomId('termina').setLabel("📅 Termina").setStyle(TextInputStyle.Short).setPlaceholder('Ej: Domingo 12 Nov 23:59h').setRequired(true);
      const premiosInput = new TextInputBuilder().setCustomId('premios').setLabel("🏅 Premios").setStyle(TextInputStyle.Paragraph).setPlaceholder('Ej:\n🥇 1ro: ...\n🥈 2do: ...').setRequired(true);
      const descripcionInput = new TextInputBuilder().setCustomId('descripcion').setLabel("📜 Descripción").setStyle(TextInputStyle.Paragraph).setPlaceholder('Reglas, qué hacer, dónde...').setRequired(true);
      const agradecimientosInput = new TextInputBuilder().setCustomId('agradecimientos').setLabel("🙏 Agradecimientos").setStyle(TextInputStyle.Short).setPlaceholder('Ej: @Admin (Opcional)').setRequired(false);
      modal.addComponents(
        new ActionRowBuilder().addComponents(comienzoInput), new ActionRowBuilder().addComponents(terminaInput),
        new ActionRowBuilder().addComponents(premiosInput), new ActionRowBuilder().addComponents(descripcionInput),
        new ActionRowBuilder().addComponents(agradecimientosInput)
      );
      await interaction.showModal(modal);
    } 

    // Comando /calcular-evento-ids
    if (interaction.commandName === 'calcular-evento-ids') {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ No tienes permisos.', flags: [MessageFlags.Ephemeral] });
        const startId = interaction.options.getString('start_id'); const endId = interaction.options.getString('end_id'); const channelId = process.env.CHANNER_ID;
        await interaction.reply({ content: `⏳ Calculando evento entre ${startId} y ${endId}...`, flags: [MessageFlags.Ephemeral] });
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.messages) throw new Error('Canal no encontrado.');
            
            // CAMBIO: halloween -> navidad
            await pool.query('TRUNCATE TABLE puntos_evento_navidad'); console.log('[EVENT CALC] Tabla histórica vaciada.');
            
            const messagesInRange = await fetchMessagesBetween(channel, startId, endId); if (messagesInRange.length === 0) return interaction.editReply({ content: '⚠️ No se encontraron mensajes.' });
            const pointsMap = new Map();
            messagesInRange.forEach(msg => { if (msg.webhookId && msg.embeds?.length > 0) { const description = msg.embeds[0].description || msg.embeds[0].title || ''; const matchUsuario = description.match(/\(([^)]+) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
            if (matchUsuario) { const usuario = matchUsuario[1].trim(); const puntosStr = matchUsuario[2]; const puntosLimpio = puntosStr.replace(/[.,]/g, ''); const puntos = parseInt(puntosLimpio);
            if (!isNaN(puntos)) { const currentPoints = pointsMap.get(usuario) || 0; pointsMap.set(usuario, currentPoints + puntos); }}}});
            
            // CAMBIO: halloween -> navidad
            if (pointsMap.size > 0) { const insertPromises = []; for (const [usuario, puntos] of pointsMap.entries()) insertPromises.push(pool.query(`INSERT INTO puntos_evento_navidad (guild, usuario, puntos) VALUES ($1, $2, $3)`, [interaction.guild.id, usuario, puntos]));
            await Promise.all(insertPromises); console.log(`[EVENT CALC] ${pointsMap.size} usuarios guardados.`); await interaction.editReply({ content: `✅ ¡Cálculo completado! ${pointsMap.size} usuarios guardados.` });
            }
            else await interaction.editReply({ content: '✅ Cálculo completado, sin puntos encontrados.' });
        } catch (error) { console.error('[EVENT CALC] Error:', error); await interaction.editReply({ content: `❌ Error: ${error.message}` });
        }
    } 

  } // Fin isChatInputCommand()


  // --- MANEJO DEL MODAL ---
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'evento-modal') {
      const comienzo = interaction.fields.getTextInputValue('comienzo');
      const termina = interaction.fields.getTextInputValue('termina');
      const premios = interaction.fields.getTextInputValue('premios');
      const descripcion = interaction.fields.getTextInputValue('descripcion');
      const agradecimientos = interaction.fields.getTextInputValue('agradecimientos');
      const eventEmbed = new EmbedBuilder()
        .setColor('#FF5733').setTitle('⚔️ ¡Nuevo Evento del Clan! ⚔️')
        .setDescription(`@everyone\n¡Atención, Clan! ¡Se viene un nuevo evento para celebrar esta Temporada de Clanes!\nPreparen sus picos, espadas y bloques. ¡Es hora de demostrar quién manda! 🏆`)
        .addFields(
          { name: '📅 FECHAS', value: `**Comienzo:** ${comienzo}\n**Termina:** ${termina}` },
          { name: '📜 DESCRIPCIÓN', value: descripcion },
          { name: '🏅 GANADORES Y PREMIOS', value: premios }
        ).setTimestamp();
      if (agradecimientos && agradecimientos.trim() !== '') eventEmbed.addFields({ name: '🙏 AGRADECIMIENTOS A', value: agradecimientos });
      try {
        const announcementChannel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
        if (announcementChannel) {
            await announcementChannel.send({ embeds: [eventEmbed] });
            await interaction.reply({ content: '✅ ¡Anuncio publicado!', flags: [MessageFlags.Ephemeral] });
        }
        else { await interaction.reply({ content: '❌ Canal de anuncios no encontrado.', flags: [MessageFlags.Ephemeral] });
        }
      } catch (error) { console.error("Error enviando anuncio:", error);
      await interaction.reply({ content: '❌ Error publicando.', flags: [MessageFlags.Ephemeral] }); }
    }
  } 

  // --- Lógica de Botones ---
  if (interaction.isButton()) {
    if (interaction.customId === 'refresh_ranking') { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const embed = await buildRankingEmbed(interaction.guild); if (rankingMessage) { await rankingMessage.edit({ embeds: [embed] }); await interaction.editReply({ content: '✅ Ranking actualizado.' });
        } else { await interaction.editReply({ content: '❌ No se pudo encontrar el mensaje.' }); } return;
    }
    if (interaction.customId === 'view_full_ranking') { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); const pageSize = 10;
        let currentPage = 0; const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
        const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;
        const displayPage = async (page, interactionRef) => { const offset = page * pageSize;
        const result = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interactionRef.guild.id, pageSize, offset]);
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('prev_page_full').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0), new ButtonBuilder().setCustomId('next_page_full').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1));
        await interactionRef.editReply({ content: `🏆 **Ranking completo (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] }); }; await displayPage(currentPage, interaction);
        const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_full', 'next_page_full'].includes(i.customId), time: 60_000 });
        collector.on('collect', async i => { if (i.customId === 'prev_page_full') currentPage--; if (i.customId === 'next_page_full') currentPage++; await i.deferUpdate(); await displayPage(currentPage, interaction); });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {})); return;
    }
    if (interaction.customId === 'view_event_ranking') { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); const pageSize = 10;
        
        // CAMBIO: halloween -> navidad
        let currentPage = 0; const totalResult = await pool.query('SELECT COUNT(*) FROM puntos_evento_navidad WHERE guild = $1', [interaction.guild.id]);
        
        const totalRows = parseInt(totalResult.rows[0].count); const totalPages = Math.ceil(totalRows / pageSize) || 1;
        const displayEventPage = async (page, interactionRef) => { const offset = page * pageSize;
        
        // CAMBIO: halloween -> navidad
        const result = await pool.query('SELECT usuario, puntos FROM puntos_evento_navidad WHERE guild = $1 ORDER BY puntos DESC LIMIT $2 OFFSET $3', [interactionRef.guild.id, pageSize, offset]);
        
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('prev_page_event').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0), new ButtonBuilder().setCustomId('next_page_event').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1));
        
        // CAMBIO: 🎃 -> 🎄 y texto Halloween -> Navidad
        await interactionRef.editReply({ content: `🎄 **Ranking Evento Navidad (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] }); }; await displayEventPage(currentPage, interaction);
        const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_event', 'next_page_event'].includes(i.customId), time: 60_000 });
        collector.on('collect', async i => { if (i.customId === 'prev_page_event') currentPage--; if (i.customId === 'next_page_event') currentPage++; await i.deferUpdate(); await displayEventPage(currentPage, interaction); });
        collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {})); return; }
  } // Fin isButton()

});


// --- INICIO DEL BOT ---
(async () => {
  try {
    console.log('Conectando a la base de datos...');
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos" lista');
    await pool.query(`CREATE TABLE IF NOT EXISTS clan_stats (guild TEXT PRIMARY KEY, total_puntos BIGINT DEFAULT 0, paquetes_tienda INTEGER DEFAULT 0, last_processed_message_id TEXT)`);
    console.log('✅ Tabla "clan_stats" lista');
    
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS paquetes_tienda INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS last_processed_message_id TEXT`);
    console.log('✅ Columnas aseguradas en clan_stats');
    
    // CAMBIO: halloween -> navidad
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_evento_navidad (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    console.log('✅ Tabla "puntos_evento_navidad" lista');
    
    console.log('Iniciando sesión en Discord...');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) { console.error('❌ Error fatal durante el inicio:', err); process.exit(1); }
})();
