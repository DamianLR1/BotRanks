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
  TextInputStyle, PermissionsBitField, AttachmentBuilder
} = require('discord.js');
const { Pool } = require('pg');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// Registrar fuentes incluidas en el proyecto
try {
  GlobalFonts.registerFromPath(path.join(__dirname, 'Poppins-Bold.ttf'), 'Poppins');
  GlobalFonts.registerFromPath(path.join(__dirname, 'Poppins-Regular.ttf'), 'PoppinsLight');
  console.log('✅ Fuentes registradas correctamente');
} catch(e) {
  console.warn('⚠️ Error cargando fuentes:', e.message);
}
require('dotenv').config();

// ==========================================
// FUNCIONES DE AYUDA
// ==========================================

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} día${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hora${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(', ') : 'menos de un minuto';
}

function formatDate(date) {
  return new Intl.DateTimeFormat('es', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: process.env.TIMEZONE || 'America/Argentina/Buenos_Aires'
  }).format(date);
}

function createProgressBar(value, maxValue, size = 10) {
  if (value <= 0 || maxValue <= 0) return '`[          ]`';
  const percentage = value / maxValue;
  const progress = Math.round(size * percentage);
  const filled = '█'; const empty = '░';
  return `\`[${filled.repeat(progress)}${empty.repeat(size - progress)}]\``;
}

function extractPointsFromMessage(message) {
  if (!message.webhookId || !message.embeds?.length) return null;
  const description = message.embeds[0].description || message.embeds[0].title || '';
  const matchConParentesis = description.match(/\(([^)]+?) ha conseguido ([\d,.]+) puntos[^)]*\)/si);
  const matchSinParentesis = description.match(/^[^(\n]*?!\s*([^\n(]+?) ha conseguido ([\d,.]+) puntos/sim);
  const matchUsuario = matchConParentesis || matchSinParentesis;
  if (!matchUsuario) return null;
  const usuario = matchUsuario[1].trim();
  const puntos = parseInt(matchUsuario[2].replace(/[.,]/g, ''));
  if (isNaN(puntos)) return null;
  return { usuario, puntos };
}

async function fetchMessagesBetween(channel, startId, endId) {
  let allMessages = [];
  let lastId = startId;
  try {
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after: lastId });
      if (messages.size === 0) break;
      let reachedEnd = false;
      messages.forEach(msg => {
        if (BigInt(msg.id) <= BigInt(endId)) allMessages.push(msg);
        else reachedEnd = true;
      });
      lastId = messages.first().id;
      if (reachedEnd) break;
      if (allMessages.length > 10000) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) { console.error('[fetchMessagesBetween] Error:', error); }
  return allMessages;
}

// ==========================================
// CANVAS - GENERADOR DE TARJETA DE RANKING
// ==========================================

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}


function drawMedal(ctx, x, y, rank, FONT) {
  const colors = {
    1: { bg: '#B8860B44', border: '#FFD700', text: '#FFD700' },
    2: { bg: '#66666644', border: '#C0C0C0', text: '#C0C0C0' },
    3: { bg: '#7a3a0044', border: '#CD7F32', text: '#CD7F32' },
  };
  const c = colors[rank];
  ctx.fillStyle = c.bg;
  ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = c.border; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI*2); ctx.stroke();
  ctx.fillStyle = c.text;
  ctx.font = '700 16px "' + FONT + '"';
  ctx.textAlign = 'center';
  ctx.fillText(String(rank), x, y+6);
}

function drawTrophy(ctx, x, y, size, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x-size*0.4, y-size*0.5); ctx.lineTo(x+size*0.4, y-size*0.5);
  ctx.quadraticCurveTo(x+size*0.45, y, x, y+size*0.2);
  ctx.quadraticCurveTo(x-size*0.45, y, x-size*0.4, y-size*0.5);
  ctx.fill();
  ctx.fillRect(x-size*0.15, y+size*0.2, size*0.3, size*0.2);
  ctx.fillRect(x-size*0.3, y+size*0.38, size*0.6, size*0.1);
  ctx.beginPath(); ctx.arc(x-size*0.4, y-size*0.2, size*0.15, Math.PI*0.5, Math.PI*1.5); ctx.stroke();
  ctx.beginPath(); ctx.arc(x+size*0.4, y-size*0.2, size*0.15, -Math.PI*0.5, Math.PI*0.5); ctx.stroke();
}

async function generarRankingCanvas({ usuarios, temporada, totalPuntos, guildIconURL }) {
  const W = 900, H = 740;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const GOLD      = '#FFD700';
  const GOLD_DIM  = '#D4AF37';
  const GOLD_DARK = '#8a6010';
  const SILVER    = '#C0C0C0';
  const BRONZE    = '#CD7F32';
  const BG        = '#0a0a0a';
  const LINE      = '#1e1a0a';
  const TEXT_DIM  = '#6a5a30';
  const TEXT_MID  = '#a09060';
  const TEXT_LIGHT= '#c8b878';

  // --- FONDO ---
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Grid sutil
  ctx.strokeStyle = 'rgba(212,175,55,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Borde exterior
  ctx.strokeStyle = '#2a2000';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0, 0, W, H, 16, false, true);

  // Línea dorada superior
  const topGrad = ctx.createLinearGradient(0, 0, W, 0);
  topGrad.addColorStop(0, 'transparent');
  topGrad.addColorStop(0.3, GOLD_DIM);
  topGrad.addColorStop(0.5, GOLD);
  topGrad.addColorStop(0.7, GOLD_DIM);
  topGrad.addColorStop(1, 'transparent');
  ctx.strokeStyle = topGrad;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(W, 1); ctx.stroke();

  // --- HEADER ---
  const headerH = 110;
  const iconX = 24, iconY = 17, iconR = 38;

  // Cargar ícono del clan si hay URL
  let guildIcon = null;
  if (guildIconURL) {
    try { guildIcon = await loadImage(guildIconURL); } catch (_) {}
  }

  // Ícono clan (pequeño, bien posicionado)
  const iconR2 = 28, iconX2 = 22, iconY2 = 22;
  ctx.save();
  ctx.beginPath(); ctx.arc(iconX2+iconR2, iconY2+iconR2, iconR2, 0, Math.PI*2); ctx.clip();
  if (guildIcon) {
    ctx.drawImage(guildIcon, iconX2, iconY2, iconR2*2, iconR2*2);
  } else {
    const iconGrad = ctx.createRadialGradient(iconX2+iconR2, iconY2+iconR2, 0, iconX2+iconR2, iconY2+iconR2, iconR2);
    iconGrad.addColorStop(0, '#3a2a00'); iconGrad.addColorStop(1, '#1a1200');
    ctx.fillStyle = iconGrad; ctx.fillRect(iconX2, iconY2, iconR2*2, iconR2*2);
    ctx.fillStyle = GOLD; ctx.font = '700 14px "Poppins"'; ctx.textAlign = 'center';
    ctx.fillText('CLAN', iconX2+iconR2, iconY2+iconR2+5);
  }
  ctx.restore();
  ctx.shadowColor = 'rgba(212,175,55,0.5)'; ctx.shadowBlur = 14;
  ctx.strokeStyle = GOLD_DIM; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(iconX2+iconR2, iconY2+iconR2, iconR2, 0, Math.PI*2); ctx.stroke();
  ctx.shadowBlur = 0;

  // Texto header bien separado del ícono
  const textX = iconX2 + iconR2*2 + 18;
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT_DIM; ctx.font = '700 12px "Poppins"';
  ctx.fillText('TEMPORADA DE CLAN', textX, 40);
  ctx.fillStyle = GOLD; ctx.font = '700 30px "Poppins"';
  ctx.shadowColor = 'rgba(255,215,0,0.25)'; ctx.shadowBlur = 12;
  ctx.fillText(temporada, textX, 78);
  ctx.shadowBlur = 0;

  // Trofeo dibujado (sin emoji)
  ctx.shadowColor = 'rgba(255,215,0,0.4)'; ctx.shadowBlur = 10;
  drawTrophy(ctx, W-50, 55, 38, GOLD);
  ctx.shadowBlur = 0;

  // Línea separadora header
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, headerH); ctx.lineTo(W - 16, headerH); ctx.stroke();

  // --- TOTAL STRIP ---
  const stripY = headerH;
  const stripH = 48;
  const stripGrad = ctx.createLinearGradient(0, stripY, W, stripY);
  stripGrad.addColorStop(0, '#120e00');
  stripGrad.addColorStop(0.5, '#1a1500');
  stripGrad.addColorStop(1, '#120e00');
  ctx.fillStyle = stripGrad;
  ctx.fillRect(0, stripY, W, stripH);

  ctx.fillStyle = TEXT_DIM;
  ctx.font = '700 10px "Poppins"';
  ctx.textAlign = 'left';
  ctx.fillText('⚡  TOTAL DEL CLAN', 24, stripY + 21);

  ctx.fillStyle = GOLD;
  ctx.font = '700 18px "DejaVu Sans Mono"';
  ctx.textAlign = 'right';
  ctx.fillText(Number(totalPuntos).toLocaleString('es') + ' pts', W - 24, stripY + 21);
  ctx.textAlign = 'left';

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, stripY + stripH); ctx.lineTo(W, stripY + stripH); ctx.stroke();

  // --- RANKING ---
  const listStartY = stripY + stripH + 8;
  const rowH = 54;
  const topPoints = usuarios[0]?.puntos || 1;

  const nameColors  = [GOLD, SILVER, BRONZE, TEXT_LIGHT, TEXT_LIGHT, TEXT_LIGHT, TEXT_MID, TEXT_MID, TEXT_MID, TEXT_MID];
  const ptsColors   = [GOLD, SILVER, BRONZE, TEXT_MID, TEXT_MID, TEXT_MID, TEXT_DIM, TEXT_DIM, TEXT_DIM, TEXT_DIM];
  const accentColors = [GOLD, SILVER, BRONZE];
  const barGrads = [
    [GOLD_DARK, GOLD],
    ['#707070', SILVER],
    ['#8B4513', BRONZE],
  ];
  const rowBgColors = [
    ['rgba(255,215,0,0.08)', 'transparent'],
    ['rgba(192,192,192,0.05)', 'transparent'],
    ['rgba(205,127,50,0.05)', 'transparent'],
  ];

  usuarios.forEach((row, i) => {
    const y = listStartY + i * rowH;
    const isPodio = i < 3;

    // Fondo fila podio
    if (isPodio) {
      const bg = ctx.createLinearGradient(16, y, W - 16, y);
      bg.addColorStop(0, rowBgColors[i][0]);
      bg.addColorStop(1, rowBgColors[i][1]);
      ctx.fillStyle = bg;
      roundRect(ctx, 16, y + 2, W - 32, rowH - 4, 6, true, false);
    }

    // Barra acento izquierda (podio)
    if (isPodio) {
      ctx.fillStyle = accentColors[i];
      if (i === 0) { ctx.shadowColor = 'rgba(255,215,0,0.6)'; ctx.shadowBlur = 6; }
      ctx.fillRect(16, y + 8, 3, rowH - 16);
      ctx.shadowBlur = 0;
    }

    // Posición
    const posX = 52;
    if (isPodio) {
      ctx.font = '18px serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(['🥇','🥈','🥉'][i], posX, y + rowH / 2 + 10);
    } else {
      ctx.fillStyle = TEXT_DIM;
      ctx.font = '700 15px "Poppins"';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), posX, y + rowH / 2 + 6);
    }

    // Nombre (truncar si es muy largo)
    ctx.font = isPodio ? '700 20px "Poppins"' : '600 17px "Poppins"';
    ctx.fillStyle = nameColors[i];
    ctx.textAlign = 'left';
    let nombre = row.usuario;
    while (ctx.measureText(nombre).width > 185 && nombre.length > 3) nombre = nombre.slice(0, -1);
    if (nombre !== row.usuario) nombre += '…';
    ctx.fillText(nombre, 78, y + rowH / 2 + 5);

    // Puntos
    ctx.fillStyle = ptsColors[i];
    ctx.font = isPodio ? '700 17px "DejaVu Sans Mono"' : '600 15px "DejaVu Sans Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(row.puntos.toLocaleString('es') + ' pts', W - 150, y + rowH / 2 + 7);

    // Barra de progreso
    const barX = W - 136, barW = 120, barH2 = 6, barY = y + rowH / 2 - 1;
    const pct = row.puntos / topPoints;

    ctx.fillStyle = '#1a1500';
    roundRect(ctx, barX, barY, barW, barH2, 2, true, false);

    const barFill = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    if (i < 3) {
      barFill.addColorStop(0, barGrads[i][0]);
      barFill.addColorStop(1, barGrads[i][1]);
    } else {
      barFill.addColorStop(0, '#3a2e00');
      barFill.addColorStop(1, GOLD_DARK);
    }
    ctx.fillStyle = barFill;
    if (i === 0) { ctx.shadowColor = 'rgba(255,215,0,0.3)'; ctx.shadowBlur = 4; }
    roundRect(ctx, barX, barY, Math.max(barW * pct, 6), barH2, 2, true, false);
    ctx.shadowBlur = 0;

    // Divisor punteado entre podio y resto
    if (i === 2) {
      ctx.strokeStyle = '#2a2000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(24, y + rowH + 2);
      ctx.lineTo(W - 24, y + rowH + 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // --- FOOTER ---
  const footerY = H - 32;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, footerY); ctx.lineTo(W - 16, footerY); ctx.stroke();

  ctx.fillStyle = TEXT_DIM;
  ctx.font = '12px "Poppins"';
  ctx.textAlign = 'left';
  ctx.fillText('Ranking · Actualizado ' + formatDate(new Date()), 24, footerY + 16);

  // Dots decorativos
  [0,1,2].forEach((d, i) => {
    ctx.fillStyle = i === 0 ? GOLD_DIM : '#2a2010';
    ctx.beginPath();
    ctx.arc(W - 30 + i * 8, footerY + 13, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  return canvas.toBuffer('image/png');
}

// ==========================================
// CONFIGURACIÓN DB Y CLIENTE
// ==========================================

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

// ==========================================
// COMANDOS SLASH
// ==========================================

const commands = [
  new SlashCommandBuilder().setName('rankclan').setDescription('Muestra el ranking de los miembros con más puntos').toJSON(),
  new SlashCommandBuilder().setName('estadisticas').setDescription('Muestra estadísticas generales del clan').toJSON(),
  new SlashCommandBuilder().setName('evento-temporada').setDescription('[Admin] Cambia el nombre de la temporada.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).toJSON(),
  new SlashCommandBuilder().setName('iniciar-evento').setDescription('[Admin] Crea el anuncio del evento e inicia el rastreo de puntos.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).toJSON(),
  new SlashCommandBuilder().setName('cerrar-evento').setDescription('[Admin] Cierra el evento activo y publica el podio final.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).toJSON(),
  new SlashCommandBuilder().setName('evento-estado').setDescription('Muestra el ranking parcial del evento activo.').toJSON(),
  new SlashCommandBuilder().setName('calcular-evento-ids').setDescription('[Admin] Calcula el ranking de un evento entre dos IDs de mensaje.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('start_id').setDescription('ID del primer mensaje del evento').setRequired(true))
    .addStringOption(o => o.setName('end_id').setDescription('ID del último mensaje del evento').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('calcular-inicio').setDescription('[Admin] Resetea el rastreo desde un ID y sincroniza los puntos perdidos.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('message_id').setDescription('ID del mensaje DESDE donde empezar a contar (exclusivo)').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName('reiniciar-rank').setDescription('[Admin] ⚠️ BORRA todos los puntos y reinicia el ranking a cero.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator).toJSON(),
];

// ==========================================
// ESTADO EN MEMORIA
// ==========================================

let rankingMessage = null;
let eventRankingMessage = null;

// ==========================================
// POST RANKING (CANVAS)
// ==========================================

const postRankingMessage = async () => {
  try {
    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) return;

    const guild = channel.guild;
    const resultUsuarios = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 10', [guild.id]);
    const resultStats = await pool.query('SELECT total_puntos, temporada_nombre FROM clan_stats WHERE guild = $1', [guild.id]);
    const stats = resultStats.rows[0] || { total_puntos: 0, temporada_nombre: 'TEMPORADA' };

    // Generar imagen canvas
    const imageBuffer = await generarRankingCanvas({
      usuarios: resultUsuarios.rows,
      temporada: stats.temporada_nombre || 'TEMPORADA',
      totalPuntos: Number(stats.total_puntos || 0),
      guildIconURL: guild.iconURL({ extension: 'png', size: 128 })
    });

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'ranking.png' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh_ranking').setLabel('🔄 Actualizar').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('view_full_ranking').setLabel('➡️ Ver más').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('view_event_ranking').setLabel('🏆 Ranking Evento').setStyle(ButtonStyle.Success)
    );

    if (!rankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      rankingMessage = pinned.find(m => m.author.id === client.user.id && m.attachments.some(a => a.name === 'ranking.png'));
    }

    if (!rankingMessage) {
      const msg = await channel.send({ files: [attachment], components: [row] });
      await msg.pin();
      rankingMessage = msg;
    } else {
      await rankingMessage.edit({ files: [attachment], components: [row] });
    }
  } catch (err) { console.error('❌ Error en postRankingMessage:', err); }
};

// ==========================================
// POST EVENT RANKING (EMBED — sin canvas para el evento)
// ==========================================

const postEventRankingMessage = async () => {
  try {
    const guildId = process.env.GUILD_ID;
    const eventoResult = await pool.query(`SELECT id, nombre FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [guildId]);
    if (eventoResult.rows.length === 0) return;
    const evento = eventoResult.rows[0];

    const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    if (!channel) return;

    if (!eventRankingMessage) {
      const pinned = await channel.messages.fetchPinned();
      eventRankingMessage = pinned.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Ranking —'));
    }

    const result = await pool.query('SELECT usuario, puntos FROM puntos_evento WHERE evento_id = $1 AND guild = $2 ORDER BY puntos DESC LIMIT 10', [evento.id, guildId]);
    const topPoints = result.rows.length ? result.rows[0].puntos : 1;
    const medallas = ['🥇','🥈','🥉'];
    const embed = new EmbedBuilder()
      .setAuthor({ name: 'EVENTO EN CURSO' })
      .setTitle(`⚔️ Ranking — ${evento.nombre}`)
      .setColor('#FF5733')
      .setImage(channel.guild.iconURL())
      .setTimestamp();

    if (result.rows.length === 0) {
      embed.setDescription('Aún no hay puntos registrados.');
    } else {
      const lines = result.rows.map((row, i) => {
        const rank = medallas[i] || `**${i+1}.**`;
        return `${rank} **${row.usuario}**\n   \`${row.puntos} pts\` ${createProgressBar(row.puntos, topPoints, 10)}`;
      }).join('\n\n');
      embed.addFields({ name: '➥ Ranking del Evento', value: lines });
    }

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
  } catch (err) { console.error('❌ Error en postEventRankingMessage:', err); }
};

// ==========================================
// PROCESAMIENTO DE MENSAJES
// ==========================================

async function processWebhookMessage(message) {
  if (!message.guild?.id || !message.webhookId || !message.embeds?.length) return;
  const description = message.embeds[0].description || message.embeds[0].title || '';
  const guildId = message.guild.id;
  const extracted = extractPointsFromMessage(message);

  if (extracted) {
    const { usuario, puntos } = extracted;
    try {
      await pool.query(`INSERT INTO puntos (guild, usuario, puntos) VALUES ($1, $2, $3) ON CONFLICT (guild, usuario) DO UPDATE SET puntos = puntos.puntos + $3`, [guildId, usuario, puntos]);
      const hoy = new Date().toISOString().split('T')[0];
      await pool.query(`INSERT INTO puntos_diarios (guild, usuario, fecha, puntos) VALUES ($1, $2, $3, $4) ON CONFLICT (guild, usuario, fecha) DO UPDATE SET puntos = puntos_diarios.puntos + $4`, [guildId, usuario, hoy, puntos]);
      const eventoActivo = await pool.query(`SELECT id FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [guildId]);
      if (eventoActivo.rows.length > 0) {
        await pool.query(`INSERT INTO puntos_evento (evento_id, guild, usuario, puntos) VALUES ($1, $2, $3, $4) ON CONFLICT (evento_id, guild, usuario) DO UPDATE SET puntos = puntos_evento.puntos + $4`, [eventoActivo.rows[0].id, guildId, usuario, puntos]);
      }
      console.log(`[PROCESS] 🟢 ${usuario} ganó ${puntos} puntos (ID: ${message.id})`);
    } catch (err) { console.error(`[PROCESS] ❌ Error:`, err); }
  }

  const matchTotal = description.match(/ahora tiene\s+([0-9,.]+)\s+puntos de experiencia/si);
  if (matchTotal) {
    const totalPuntos = BigInt(matchTotal[1].replace(/[,.]/g, ''));
    try {
      await pool.query(`INSERT INTO clan_stats (guild, total_puntos) VALUES ($1, $2) ON CONFLICT (guild) DO UPDATE SET total_puntos = $2`, [guildId, totalPuntos]);
    } catch (err) { console.error('[PROCESS] ❌ Error total:', err); }
  }
}

async function syncRecentPoints(channelId, guildId) {
  console.log(`[SYNC] 🚀 Iniciando sincronización...`);
  let lastProcessedId = process.env.RESET_MESSAGE_ID;
  try {
    const result = await pool.query('SELECT last_processed_message_id FROM clan_stats WHERE guild = $1', [guildId]);
    if (result.rows.length > 0 && result.rows[0].last_processed_message_id) lastProcessedId = result.rows[0].last_processed_message_id;
    if (!lastProcessedId) { console.warn('[SYNC] ⚠️ No hay ID para sincronizar.'); return; }

    const channel = await client.channels.fetch(channelId);
    if (!channel?.messages) return;

    let newMessages = [], currentLastId = lastProcessedId, newestMessageIdInSync = lastProcessedId;
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after: currentLastId });
      if (messages.size === 0) break;
      messages.forEach(msg => { newMessages.push(msg); if (BigInt(msg.id) > BigInt(newestMessageIdInSync)) newestMessageIdInSync = msg.id; });
      currentLastId = messages.first().id;
      if (newMessages.length > 2000) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (newMessages.length > 0) {
      for (const msg of newMessages.reverse()) await processWebhookMessage(msg);
      await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [newestMessageIdInSync, guildId]);
      console.log(`[SYNC] ✅ ${newMessages.length} mensajes procesados.`);
    }
  } catch (err) { console.error(`[SYNC] ❌ Error:`, err); }
}

// ==========================================
// REPORTE DIARIO
// ==========================================

async function publicarReporteDiario() {
  try {
    const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
    const fechaAyer = ayer.toISOString().split('T')[0];
    for (const [guildId] of client.guilds.cache) {
      const result = await pool.query(`SELECT usuario, puntos FROM puntos_diarios WHERE guild = $1 AND fecha = $2 ORDER BY puntos DESC LIMIT 10`, [guildId, fechaAyer]);
      if (result.rows.length === 0) continue;
      const totalDia = result.rows.reduce((acc, row) => acc + row.puntos, 0);
      const mvp = result.rows[0];
      const medallas = ['🥇','🥈','🥉'];
      const rankingLines = result.rows.map((row, i) => `${medallas[i] || `**${i+1}.**`} **${row.usuario}** — \`${row.puntos.toLocaleString('es')} pts\``).join('\n');
      const fechaFormateada = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'long', year: 'numeric', timeZone: process.env.TIMEZONE || 'America/Argentina/Buenos_Aires' }).format(ayer);
      const embed = new EmbedBuilder()
        .setTitle(`📊 Reporte Diario — ${fechaFormateada}`)
        .setColor('#F1C40F')
        .addFields(
          { name: '🌟 MVP del día', value: `**${mvp.usuario}** con \`${mvp.puntos.toLocaleString('es')} pts\`` },
          { name: '🏆 Top aportadores', value: rankingLines },
          { name: '⚡ Total del clan hoy', value: `\`${totalDia.toLocaleString('es')} pts\``, inline: true }
        ).setTimestamp().setFooter({ text: 'Reporte generado automáticamente' });
      try {
        const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
        if (channel) await channel.send({ embeds: [embed] });
      } catch (err) { console.error(`[REPORTE DIARIO] ❌`, err); }
    }
  } catch (err) { console.error('[REPORTE DIARIO] ❌', err); }
}

function programarReporteDiario() {
  const timezone = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const manana = new Date(ahora); manana.setDate(manana.getDate() + 1); manana.setHours(0, 0, 30, 0);
  const msHasta = manana - ahora;
  console.log(`[REPORTE DIARIO] ⏰ Próximo reporte en ${Math.round(msHasta / 1000 / 60)} minutos`);
  setTimeout(async () => { await publicarReporteDiario(); setInterval(publicarReporteDiario, 24 * 60 * 60 * 1000); }, msHasta);
}

// ==========================================
// PODIO DE CIERRE DE EVENTO
// ==========================================

async function publicarPodio(guild, evento, pointsMap, totalClan, duracionMs, channel) {
  if (pointsMap.size === 0) { await channel.send({ content: '⚠️ No se encontraron puntos en este evento.' }); return; }
  const sorted = [...pointsMap.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 10); const mvp = top[0];
  const medallas = ['🥇','🥈','🥉'];
  const rankingLines = top.map(([usuario, puntos], i) => `${medallas[i] || `**${i+1}.**`} **${usuario}** — \`${puntos.toLocaleString('es')} pts\``).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ EVENTO FINALIZADO — ${evento.nombre}`).setColor('#E74C3C')
    .setDescription('¡El evento ha concluido! Aquí están los resultados finales.')
    .addFields(
      { name: '🌟 MVP del evento', value: `**${mvp[0]}** con \`${mvp[1].toLocaleString('es')} pts\`` },
      { name: '\u200B', value: '\u200B' },
      { name: '🗓️ Período', value: `**Inicio:** ${evento.inicio_texto || formatDate(new Date(evento.inicio))}\n**Fin:** ${evento.fin_texto || formatDate(new Date())}` },
      { name: '\u200B', value: '\u200B' },
      { name: '🏆 Podio Final', value: rankingLines },
      { name: '\u200B', value: '\u200B' },
      { name: '⚡ Total del clan en el evento', value: `\`${totalClan.toLocaleString('es')} pts\``, inline: true },
      { name: '👥 Participantes', value: `\`${pointsMap.size}\``, inline: true },
      { name: '⏱️ Duración', value: formatDuration(duracionMs), inline: true }
    ).setImage(guild.iconURL()).setTimestamp().setFooter({ text: '¡Gracias a todos por participar!' });
  await channel.send({ content: '@everyone', embeds: [embed] });
}

// ==========================================
// EVENTOS DEL CLIENTE
// ==========================================

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
    console.log('✅ Comandos registrados');
  } catch (error) { console.error('❌ Error registrando comandos:', error); }

  await syncRecentPoints(process.env.CHANNEL_ID, process.env.GUILD_ID);
  await postRankingMessage();

  const eventoActivo = await pool.query(`SELECT id FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [process.env.GUILD_ID]);
  if (eventoActivo.rows.length > 0) await postEventRankingMessage();

  setInterval(postRankingMessage, 5 * 60 * 1000);
  setInterval(async () => {
    const ev = await pool.query(`SELECT id FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [process.env.GUILD_ID]);
    if (ev.rows.length > 0) await postEventRankingMessage();
  }, 5 * 60 * 1000);

  programarReporteDiario();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channel.id === process.env.CHANNEL_ID) {
    await processWebhookMessage(message);
    if (message.guild?.id) {
      try { await pool.query(`UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2`, [message.id, message.guild.id]); }
      catch (err) { console.error(`[MessageCreate] ❌`, err); }
    }
  }
});

// ==========================================
// INTERACCIONES
// ==========================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;

  if (interaction.isChatInputCommand()) {

    // /ESTADISTICAS
    if (interaction.commandName === 'estadisticas') {
      await interaction.deferReply();
      try {
        const guildId = interaction.guild.id;
        const statsResult = await pool.query('SELECT total_puntos, temporada_nombre FROM clan_stats WHERE guild = $1', [guildId]);
        const stats = statsResult.rows[0] || { total_puntos: 0, temporada_nombre: 'Sin nombre' };
        const totalMiembros = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [guildId]);
        const mvpResult = await pool.query('SELECT usuario, puntos FROM puntos WHERE guild = $1 ORDER BY puntos DESC LIMIT 1', [guildId]);
        const promedioResult = await pool.query('SELECT AVG(puntos) as promedio FROM puntos WHERE guild = $1', [guildId]);
        const totalEventos = await pool.query('SELECT COUNT(*) FROM eventos WHERE guild = $1', [guildId]);
        const eventoActivoResult = await pool.query(`SELECT nombre FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [guildId]);
        const mvp = mvpResult.rows[0];
        const promedio = promedioResult.rows[0]?.promedio ? Math.round(promedioResult.rows[0].promedio) : 0;
        const eventoActivo = eventoActivoResult.rows[0];
        const embed = new EmbedBuilder()
          .setAuthor({ name: 'ESTADÍSTICAS DEL CLAN' }).setTitle('📊 Resumen General').setColor('#3498DB')
          .setThumbnail(interaction.guild.iconURL()).setTimestamp()
          .addFields(
            { name: '🏆 Temporada activa', value: `\`${stats.temporada_nombre || 'Sin nombre'}\``, inline: true },
            { name: '👥 Miembros con puntos', value: `\`${totalMiembros.rows[0].count}\``, inline: true },
            { name: '⚔️ Eventos realizados', value: `\`${totalEventos.rows[0].count}\``, inline: true },
            { name: '🌟 Puntos totales del clan', value: `\`${BigInt(stats.total_puntos || 0).toLocaleString('es')} pts\``, inline: true },
            { name: '📈 Promedio por miembro', value: `\`${promedio.toLocaleString('es')} pts\``, inline: true },
            { name: '🔥 Evento activo', value: eventoActivo ? `\`${eventoActivo.nombre}\`` : '`Ninguno`', inline: true }
          );
        if (mvp) { embed.addFields({ name: '\u200B', value: '\u200B' }, { name: '👑 MVP del clan (general)', value: `**${mvp.usuario}** — \`${mvp.puntos.toLocaleString('es')} pts\`` }); }
        await interaction.editReply({ embeds: [embed] });
      } catch (err) { console.error(err); await interaction.editReply({ content: '❌ Error al obtener estadísticas.' }); }
    }

    // /EVENTO-TEMPORADA
    if (interaction.commandName === 'evento-temporada') {
      const modal = new ModalBuilder().setCustomId('evento-temporada-modal').setTitle('Cambiar Nombre de Temporada');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('evento_nombre').setLabel('🏆 Nombre de la temporada')
          .setStyle(TextInputStyle.Short).setPlaceholder('Ej: 🎄 NAVIDAD  /  ☀️ VERANO  /  🎃 HALLOWEEN').setMaxLength(50).setRequired(true)
      ));
      await interaction.showModal(modal);
    }

    // /INICIAR-EVENTO
    if (interaction.commandName === 'iniciar-evento') {
      const eventoExistente = await pool.query(`SELECT nombre FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [interaction.guild.id]);
      if (eventoExistente.rows.length > 0) return interaction.reply({ content: `❌ Ya hay un evento activo: **${eventoExistente.rows[0].nombre}**.\nUsá \`/cerrar-evento\` antes de crear uno nuevo.`, flags: [MessageFlags.Ephemeral] });
      const modal = new ModalBuilder().setCustomId('iniciar-evento-modal').setTitle('Iniciar Nuevo Evento del Clan');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nombre').setLabel('🏆 Nombre del evento').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Torneo de Navidad 2025').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comienzo').setLabel('📅 Comienzo').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Viernes 10 Nov 20:00h').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('termina').setLabel('📅 Termina').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Domingo 12 Nov 23:59h').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('premios').setLabel('🏅 Premios').setStyle(TextInputStyle.Paragraph).setPlaceholder('Ej:\n🥇 1ro: ...\n🥈 2do: ...').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start_id').setLabel('📌 ID de inicio (vacío = desde ahora)').setStyle(TextInputStyle.Short).setPlaceholder('Dejar vacío para iniciar desde este momento').setRequired(false))
      );
      await interaction.showModal(modal);
    }

    // /CERRAR-EVENTO
    if (interaction.commandName === 'cerrar-evento') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        const guildId = interaction.guild.id;
        const eventoResult = await pool.query(`SELECT id, nombre, start_message_id, inicio, inicio_texto, fin_texto FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [guildId]);
        if (eventoResult.rows.length === 0) return interaction.editReply({ content: '⚠️ No hay ningún evento activo.' });
        const evento = eventoResult.rows[0];
        await interaction.editReply({ content: `⏳ Calculando resultados del evento **${evento.nombre}**...` });
        const pointsChannel = await client.channels.fetch(process.env.CHANNEL_ID);
        const lastMessages = await pointsChannel.messages.fetch({ limit: 1 });
        const lastMsg = lastMessages.first();
        const messagesInRange = await fetchMessagesBetween(pointsChannel, evento.start_message_id, lastMsg.id);
        const pointsMap = new Map();
        messagesInRange.forEach(msg => { const ex = extractPointsFromMessage(msg); if (ex) pointsMap.set(ex.usuario, (pointsMap.get(ex.usuario) || 0) + ex.puntos); });
        const totalClan = [...pointsMap.values()].reduce((acc, v) => acc + v, 0);
        const duracionMs = Date.now() - new Date(evento.inicio).getTime();
        await pool.query(`UPDATE eventos SET activo = false, fin = NOW() WHERE id = $1`, [evento.id]);
        for (const [usuario, puntos] of pointsMap.entries()) {
          await pool.query(`INSERT INTO puntos_evento (evento_id, guild, usuario, puntos) VALUES ($1, $2, $3, $4) ON CONFLICT (evento_id, guild, usuario) DO UPDATE SET puntos = $4`, [evento.id, guildId, usuario, puntos]);
        }
        const eventsChannel = await client.channels.fetch(process.env.EVENTS_CHANNEL_ID);
        if (eventsChannel) await publicarPodio(interaction.guild, evento, pointsMap, totalClan, duracionMs, eventsChannel);
        if (eventRankingMessage) { try { await eventRankingMessage.delete(); } catch (_) {} eventRankingMessage = null; }
        console.log(`[CERRAR-EVENTO] ✅ "${evento.nombre}" cerrado por ${interaction.user.tag}`);
        await interaction.editReply({ content: `✅ **Evento "${evento.nombre}" cerrado.** El podio fue publicado en <#${process.env.EVENTS_CHANNEL_ID}>.` });
      } catch (err) { console.error(err); await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

    // /EVENTO-ESTADO
    if (interaction.commandName === 'evento-estado') {
      await interaction.deferReply();
      try {
        const guildId = interaction.guild.id;
        const eventoResult = await pool.query(`SELECT id, nombre, inicio FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [guildId]);
        if (eventoResult.rows.length === 0) return interaction.editReply({ content: '📭 No hay ningún evento activo.' });
        const evento = eventoResult.rows[0];
        const duracionMs = Date.now() - new Date(evento.inicio).getTime();
        const topResult = await pool.query(`SELECT usuario, puntos FROM puntos_evento WHERE evento_id = $1 AND guild = $2 ORDER BY puntos DESC LIMIT 5`, [evento.id, guildId]);
        const medallas = ['🥇','🥈','🥉'];
        const topLines = topResult.rows.length > 0 ? topResult.rows.map((row, i) => `${medallas[i] || `**${i+1}.**`} **${row.usuario}** — \`${row.puntos.toLocaleString('es')} pts\``).join('\n') : '*Sin puntos aún*';
        const totalEvento = topResult.rows.reduce((acc, row) => acc + row.puntos, 0);
        const embed = new EmbedBuilder().setTitle(`⚔️ Evento Activo — ${evento.nombre}`).setColor('#3498DB')
          .addFields(
            { name: '📅 Inicio', value: formatDate(new Date(evento.inicio)), inline: true },
            { name: '⏱️ Transcurrido', value: formatDuration(duracionMs), inline: true },
            { name: '\u200B', value: '\u200B' },
            { name: '🏆 Top 5 del evento', value: topLines },
            { name: '⚡ Total del clan en el evento', value: `\`${totalEvento.toLocaleString('es')} pts\``, inline: true }
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } catch (err) { console.error(err); await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

    // /CALCULAR-EVENTO-IDS
    if (interaction.commandName === 'calcular-evento-ids') {
      const startId = interaction.options.getString('start_id'), endId = interaction.options.getString('end_id');
      await interaction.reply({ content: `⏳ Calculando evento entre ${startId} y ${endId}...`, flags: [MessageFlags.Ephemeral] });
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel?.messages) throw new Error('Canal no encontrado.');
        await pool.query('TRUNCATE TABLE puntos_evento_navidad');
        const messagesInRange = await fetchMessagesBetween(channel, startId, endId);
        if (messagesInRange.length === 0) return interaction.editReply({ content: '⚠️ No se encontraron mensajes.' });
        const pointsMap = new Map();
        messagesInRange.forEach(msg => { const ex = extractPointsFromMessage(msg); if (ex) pointsMap.set(ex.usuario, (pointsMap.get(ex.usuario) || 0) + ex.puntos); });
        if (pointsMap.size > 0) {
          await Promise.all([...pointsMap.entries()].map(([usuario, puntos]) => pool.query(`INSERT INTO puntos_evento_navidad (guild, usuario, puntos) VALUES ($1, $2, $3)`, [interaction.guild.id, usuario, puntos])));
          await interaction.editReply({ content: `✅ ¡Cálculo completado! ${pointsMap.size} usuarios guardados.` });
        } else await interaction.editReply({ content: '✅ Sin puntos encontrados.' });
      } catch (error) { await interaction.editReply({ content: `❌ Error: ${error.message}` }); }
    }

    // /CALCULAR-INICIO
    if (interaction.commandName === 'calcular-inicio') {
      const startMsgId = interaction.options.getString('message_id'), guildId = interaction.guild.id;
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query('UPDATE clan_stats SET last_processed_message_id = $1 WHERE guild = $2', [startMsgId, guildId]);
        await interaction.editReply({ content: `✅ ID establecido a ${startMsgId}. Sincronizando...` });
        await syncRecentPoints(process.env.CHANNEL_ID, guildId);
        await interaction.editReply({ content: `✅ **Sincronización completada** desde el ID ${startMsgId}.` });
      } catch (err) { await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

    // /REINICIAR-RANK
    if (interaction.commandName === 'reiniciar-rank') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query('TRUNCATE TABLE puntos');
        await pool.query('UPDATE clan_stats SET total_puntos = 0');
        await interaction.editReply({ content: '✅ **¡Ranking reiniciado!**\nUsá `/calcular-inicio [ID]` para recontar.' });
      } catch (err) { await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

    // /RANKCLAN
    if (interaction.commandName === 'rankclan') {
      await interaction.deferReply();
      const pageSize = 10; let currentPage = 0;
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count), totalPages = Math.ceil(totalRows / pageSize) || 1;
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
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_cmd','next_page_cmd'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_cmd') currentPage--; else currentPage++; await i.deferUpdate(); await fetchAndDisplay(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }

  } // Fin isChatInputCommand()

  // =====================
  // MODALES
  // =====================
  if (interaction.isModalSubmit()) {

    if (interaction.customId === 'iniciar-evento-modal') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        const guildId = interaction.guild.id;
        const nombre = interaction.fields.getTextInputValue('nombre').trim();
        const comienzo = interaction.fields.getTextInputValue('comienzo').trim();
        const termina = interaction.fields.getTextInputValue('termina').trim();
        const premios = interaction.fields.getTextInputValue('premios').trim();
        const startIdRaw = interaction.fields.getTextInputValue('start_id').trim();
        let startMessageId = startIdRaw;
        if (!startMessageId) {
          const channel = await client.channels.fetch(process.env.CHANNEL_ID);
          const lastMessages = await channel.messages.fetch({ limit: 1 });
          startMessageId = lastMessages.first()?.id || process.env.RESET_MESSAGE_ID;
        }
        const eventoResult = await pool.query(`INSERT INTO eventos (guild, nombre, start_message_id, inicio, inicio_texto, fin_texto, activo) VALUES ($1, $2, $3, NOW(), $4, $5, true) RETURNING id`, [guildId, nombre, startMessageId, comienzo, termina]);
        const eventoId = eventoResult.rows[0].id;
        if (startIdRaw) {
          await interaction.editReply({ content: `⏳ Cargando puntos históricos desde ID ${startIdRaw}...` });
          const channel = await client.channels.fetch(process.env.CHANNEL_ID);
          let messages = [], currentLastId = startIdRaw;
          while (true) {
            const batch = await channel.messages.fetch({ limit: 100, after: currentLastId });
            if (batch.size === 0) break;
            batch.forEach(msg => messages.push(msg));
            currentLastId = batch.first().id;
            if (messages.length > 5000) break;
            await new Promise(r => setTimeout(r, 500));
          }
          const pointsMap = new Map();
          messages.forEach(msg => { const ex = extractPointsFromMessage(msg); if (ex) pointsMap.set(ex.usuario, (pointsMap.get(ex.usuario) || 0) + ex.puntos); });
          for (const [usuario, puntos] of pointsMap.entries()) {
            await pool.query(`INSERT INTO puntos_evento (evento_id, guild, usuario, puntos) VALUES ($1, $2, $3, $4) ON CONFLICT (evento_id, guild, usuario) DO UPDATE SET puntos = puntos_evento.puntos + $4`, [eventoId, guildId, usuario, puntos]);
          }
        }
        const announcementEmbed = new EmbedBuilder().setColor('#FF5733')
          .setTitle(`⚔️ ¡Nuevo Evento del Clan! — ${nombre}`)
          .setDescription(`@everyone\n¡Atención, Clan! ¡Se viene un nuevo evento!\n¡Prepárense para demostrar quién manda! 🏆`)
          .addFields(
            { name: '📅 FECHAS', value: `**Comienzo:** ${comienzo}\n**Termina:** ${termina}` },
            { name: '🏅 PREMIOS', value: premios },
            { name: '📌 Info', value: 'Cada punto que aporten al clan contará para el ranking del evento. ¡A darle! 💪' }
          ).setImage(interaction.guild.iconURL()).setTimestamp();
        const rankingChannel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
        if (rankingChannel) await rankingChannel.send({ embeds: [announcementEmbed] });
        await postEventRankingMessage();
        await interaction.editReply({ content: `✅ **¡Evento "${nombre}" iniciado!**\nAnuncio y ranking en vivo publicados en <#${process.env.RANKING_CHANNEL_ID}>.` });
      } catch (err) { console.error(err); await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

    if (interaction.customId === 'evento-temporada-modal') {
      const eventoNombre = interaction.fields.getTextInputValue('evento_nombre').trim();
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      try {
        await pool.query(`UPDATE clan_stats SET temporada_nombre = $1 WHERE guild = $2`, [eventoNombre, interaction.guild.id]);
        // Regenerar canvas inmediatamente
        await postRankingMessage();
        await interaction.editReply({ content: `✅ Temporada actualizada: \`TEMPORADA DE CLAN | ${eventoNombre}\`` });
      } catch (err) { await interaction.editReply({ content: `❌ Error: ${err.message}` }); }
    }

  }

  // =====================
  // BOTONES
  // =====================
  if (interaction.isButton()) {

    if (interaction.customId === 'refresh_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      await postRankingMessage();
      await interaction.editReply({ content: '✅ Ranking actualizado.' });
      return;
    }

    if (interaction.customId === 'refresh_event_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const eventoResult = await pool.query(`SELECT id, nombre FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [interaction.guild.id]);
      if (!eventoResult.rows.length) return interaction.editReply({ content: '❌ No hay evento activo.' });
      await postEventRankingMessage();
      await interaction.editReply({ content: '✅ Ranking del evento actualizado.' });
      return;
    }

    if (interaction.customId === 'view_full_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      const totalResult = await pool.query('SELECT COUNT(*) FROM puntos WHERE guild = $1', [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count), totalPages = Math.ceil(totalRows / pageSize) || 1;
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
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_full','next_page_full'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_full') currentPage--; else currentPage++; await i.deferUpdate(); await displayPage(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    if (interaction.customId === 'view_event_ranking') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const pageSize = 10; let currentPage = 0;
      const eventoResult = await pool.query(`SELECT id, nombre FROM eventos WHERE guild = $1 AND activo = true LIMIT 1`, [interaction.guild.id]);

      const tableName = eventoResult.rows.length ? 'puntos_evento' : 'puntos_evento_navidad';
      const whereClause = eventoResult.rows.length ? `evento_id = ${eventoResult.rows[0].id} AND guild = $1` : `guild = $1`;
      const eventoNombre = eventoResult.rows.length ? eventoResult.rows[0].nombre : 'Evento';

      const totalResult = await pool.query(`SELECT COUNT(*) FROM ${tableName} WHERE ${whereClause}`, [interaction.guild.id]);
      const totalRows = parseInt(totalResult.rows[0].count), totalPages = Math.ceil(totalRows / pageSize) || 1;

      const displayEventPage = async (page) => {
        const offset = page * pageSize;
        const result = await pool.query(`SELECT usuario, puntos FROM ${tableName} WHERE ${whereClause} ORDER BY puntos DESC LIMIT $2 OFFSET $3`, [interaction.guild.id, pageSize, offset]);
        const lines = result.rows.map((row, i) => `${offset + i + 1}. **${row.usuario}** — ${row.puntos} puntos`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev_page_event').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next_page_event').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        await interaction.editReply({ content: `🏆 **${eventoNombre} (Pág ${page + 1}/${totalPages}):**\n\n${lines.join('\n') || 'N/A'}`, components: [row] });
      };
      await displayEventPage(currentPage);
      const collector = interaction.channel.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && ['prev_page_event','next_page_event'].includes(i.customId), time: 60_000 });
      collector.on('collect', async i => { if (i.customId === 'prev_page_event') currentPage--; else currentPage++; await i.deferUpdate(); await displayEventPage(currentPage); });
      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

  }

});

// ==========================================
// INICIO DEL BOT
// ==========================================
(async () => {
  try {
    console.log('Conectando a la base de datos...');
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS clan_stats (guild TEXT PRIMARY KEY, total_puntos BIGINT DEFAULT 0, last_processed_message_id TEXT)`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS paquetes_tienda INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS last_processed_message_id TEXT`);
    await pool.query(`ALTER TABLE clan_stats ADD COLUMN IF NOT EXISTS temporada_nombre TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_evento_navidad (guild TEXT, usuario TEXT, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_diarios (guild TEXT, usuario TEXT, fecha DATE, puntos INTEGER DEFAULT 0, PRIMARY KEY (guild, usuario, fecha))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS eventos (id SERIAL PRIMARY KEY, guild TEXT NOT NULL, nombre TEXT NOT NULL, start_message_id TEXT, inicio TIMESTAMPTZ DEFAULT NOW(), fin TIMESTAMPTZ, inicio_texto TEXT, fin_texto TEXT, activo BOOLEAN DEFAULT false)`);
    await pool.query(`ALTER TABLE eventos ADD COLUMN IF NOT EXISTS inicio_texto TEXT`);
    await pool.query(`ALTER TABLE eventos ADD COLUMN IF NOT EXISTS fin_texto TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS puntos_evento (evento_id INTEGER NOT NULL, guild TEXT NOT NULL, usuario TEXT NOT NULL, puntos INTEGER DEFAULT 0, PRIMARY KEY (evento_id, guild, usuario))`);
    await pool.query(`INSERT INTO clan_stats (guild) VALUES ($1) ON CONFLICT (guild) DO NOTHING`, [process.env.GUILD_ID]);
    console.log('✅ Todas las tablas listas');
    console.log('Iniciando sesión en Discord...');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Error fatal durante el inicio:', err);
    process.exit(1);
  }
})();
