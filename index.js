require('./server.js');
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Leer IDs desde el entorno
const CHANNEL_IDS = process.env.CHANNEL_IDS.split(',');
const GUILD_IDS = process.env.GUILD_IDS.split(',');

// Registrar comandos
async function registrarComandos() {
  if (!client.user) {
    console.warn('⚠️ client.user no está listo aún');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('sfhorario')
      .setDescription('Muestra los horarios de reinicio de SF-1 y SF-2 en ambos reinicios'),
    new SlashCommandBuilder()
      .setName('schorario')
      .setDescription('Muestra los horarios de reinicio de SC-1, SC-2, y SC-3 en ambos reinicios'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔄 Registrando comandos en servidores...');
    for (const guildId of GUILD_IDS) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: commands }
      );
      console.log(`✅ Comandos registrados en servidor ${guildId}`);
    }
  } catch (error) {
    console.error('❌ Error al registrar comandos:', error);
  }
}

// Horarios en UTC
const horariosPrimerReinicio = { 'sc-2': 18, 'sc-3': 9, 'sc-1': 6, 'sf-1': 6, 'sf-2': 15 };
const horariosSegundoReinicio = { 'sc-2': 6, 'sf-2': 6 };

function calcularTimestamp(horaUTC) {
  const ahora = new Date();
  const target = new Date(ahora);
  target.setUTCHours(horaUTC, 0, 0, 0);
  if (target < ahora) target.setUTCDate(target.getUTCDate() + 1);
  return Math.floor(target.getTime() / 1000);
}

// Registro de mensajes por canal
const mensajes = {};

async function actualizarMensaje(channel) {
  let content = '**Primer reinicio:**\n\n';

  content += '**Survival custom:**\n';
  content += `🟢 **SC-1**: <t:${calcularTimestamp(horariosPrimerReinicio['sc-1'])}:R>\n`;
  content += `🟢 **SC-2**: <t:${calcularTimestamp(horariosPrimerReinicio['sc-2'])}:R>\n`;
  content += `🟢 **SC-3**: <t:${calcularTimestamp(horariosPrimerReinicio['sc-3'])}:R>\n\n`;

  content += '**Survival Fantasy:**\n';
  content += `🟢 **SF-1**: <t:${calcularTimestamp(horariosPrimerReinicio['sf-1'])}:R>\n`;
  content += `🟢 **SF-2**: <t:${calcularTimestamp(horariosPrimerReinicio['sf-2'])}:R>\n\n`;

  content += '**Segundo reinicio:**\n\n';
  content += '**Survival Custom:**\n';
  content += `🟢 **SC-2**: <t:${calcularTimestamp(horariosSegundoReinicio['sc-2'])}:R>\n`;
  content += '**Survival Fantasy:**\n';
  content += `🟢 **SF-2**: <t:${calcularTimestamp(horariosSegundoReinicio['sf-2'])}:R>`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('refrescar_horario')
      .setLabel('🔄 Refrescar')
      .setStyle(ButtonStyle.Primary)
  );

  if (mensajes[channel.id]) {
    try {
      await mensajes[channel.id].edit({ content, components: [row] });
    } catch (error) {
      console.error(`❌ No se pudo editar el mensaje anterior en canal ${channel.id}:`, error.message);
    }
  } else {
    const nuevoMensaje = await channel.send({ content, components: [row] });
    await nuevoMensaje.pin();
    mensajes[channel.id] = nuevoMensaje;
  }
}

// Interacciones
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === 'refrescar_horario') {
      await interaction.deferUpdate();
      const canal = interaction.channel;
      await actualizarMensaje(canal);
    }
    return;
  }

  if (!interaction.isCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'sfhorario') {
    const horariosSF = {
      'sf-1': { primerReinicio: calcularTimestamp(6) },
      'sf-2': { primerReinicio: calcularTimestamp(15), segundoReinicio: calcularTimestamp(6) }
    };

    const mensajeSF = `
**Horarios de reinicio de Survival Fantasy:**

**🟢 SF-1:**
- **Reinicio**: <t:${horariosSF['sf-1'].primerReinicio}:R>

**🟢 SF-2:**
- **Primer reinicio**: <t:${horariosSF['sf-2'].primerReinicio}:R>
- **Segundo reinicio**: <t:${horariosSF['sf-2'].segundoReinicio}:R>
    `;

    await interaction.reply(mensajeSF);
  }

  if (commandName === 'schorario') {
    const horariosSC = {
      'sc-1': { primerReinicio: calcularTimestamp(6) },
      'sc-2': { primerReinicio: calcularTimestamp(18), segundoReinicio: calcularTimestamp(6) },
      'sc-3': { primerReinicio: calcularTimestamp(9) }
    };

    const mensajeSC = `
**Horarios de reinicio de Survival Custom:**

**🟢 SC-1:**
- **Reinicio**: <t:${horariosSC['sc-1'].primerReinicio}:R>

**🟢 SC-2:**
- **Primer reinicio**: <t:${horariosSC['sc-2'].primerReinicio}:R>
- **Segundo reinicio**: <t:${horariosSC['sc-2'].segundoReinicio}:R>

**🟢 SC-3:**
- **Reinicio**: <t:${horariosSC['sc-3'].primerReinicio}:R>
    `;

    await interaction.reply(mensajeSC);
  }
});

// Al iniciar el bot
client.once('ready', async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  await registrarComandos();

  for (const channelId of CHANNEL_IDS) {
    try {
      const canal = await client.channels.fetch(channelId);
      await actualizarMensaje(canal);
      setInterval(() => actualizarMensaje(canal), 60 * 60 * 1000);
    } catch (error) {
      console.error(`❌ Error con canal ${channelId}:`, error.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
