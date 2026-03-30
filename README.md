# 🏆 Bot de Ranking de Clan

Bot de Discord para rastrear y mostrar puntos de clan automáticamente a partir de mensajes de webhook.

---

## ✅ Requisitos

- Node.js v18 o superior
- Una base de datos PostgreSQL (puedes usar [Neon](https://neon.tech) o [Railway](https://railway.app) gratis)
- Un bot creado en el [Discord Developer Portal](https://discord.com/developers/applications)

---

## ⚙️ Instalación

```bash
npm install discord.js pg dotenv
```

Copia el archivo `.env.example`, renómbralo a `.env` y completa todos los valores.

---

## 🔑 Variables de entorno

| Variable | Descripción |
|---|---|
| `DISCORD_TOKEN` | Token del bot (Discord Developer Portal) |
| `GUILD_ID` | ID del servidor de Discord |
| `RANKING_CHANNEL_ID` | Canal donde se publica el embed del ranking |
| `CHANNEL_ID` | Canal donde llegan los webhooks con los puntos |
| `RESET_MESSAGE_ID` | ID del mensaje desde donde empezar a contar |
| `PGHOST` | Host de la base de datos |
| `PGUSER` | Usuario de la base de datos |
| `PGPASSWORD` | Contraseña de la base de datos |
| `PGDATABASE` | Nombre de la base de datos |
| `PGPORT` | Puerto (por defecto: 5432) |

---

## 🤖 Permisos necesarios del bot

En el Discord Developer Portal, el bot necesita los siguientes permisos:
- `Send Messages`
- `Read Message History`
- `Manage Messages` (para pinear el ranking)
- `Embed Links`
- `Use Slash Commands`

En **Privileged Gateway Intents** activar:
- `MESSAGE CONTENT INTENT`

---

## 🎮 Comandos disponibles

| Comando | Descripción |
|---|---|
| `/rankclan` | Muestra el ranking completo con paginación |
| `/crear-evento` | (Admin) Publica un anuncio de evento |
| `/calcular-evento-ids` | (Admin) Calcula ranking de un evento por rango de IDs |
| `/calcular-inicio` | (Admin) Resincroniza puntos desde un mensaje específico |
| `/reiniciar-rank` | (Admin) ⚠️ Borra todos los puntos |
| `/evento-temporada` | (Admin) Cambia el nombre del evento en el ranking |

---

## 🚀 Uso con múltiples servidores

El bot soporta múltiples servidores de forma nativa. Los datos de cada servidor están separados por `guild_id`.

Para correr el bot en dos servidores distintos, simplemente crea **dos deploys separados**, cada uno con su propio archivo `.env` apuntando a su servidor y canal correspondiente. Pueden compartir la misma base de datos sin conflictos.

---

## 📝 Notas

- El bot detecta automáticamente mensajes de webhook con el formato:
  - `(Usuario ha conseguido 10.000 puntos para este clan)`
  - `Usuario ha conseguido 1.000 puntos para este clan`
- El ranking se actualiza automáticamente cada 5 minutos.
- El embed del ranking se pinea en el canal configurado.
