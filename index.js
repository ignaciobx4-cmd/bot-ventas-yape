import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';

// Servidor Express para mantener vivo el Web Service en Render
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp de Agencia Web Activo');
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});

// Inicializar Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT_VENTAS = `
Eres un asesor de ventas directo, conciso y muy persuasivo para nuestra agencia de desarrollo web.

TUS REGLAS DE ORO:
1. BREVEDAD EXTREMA: Responde SIEMPRE en un máximo de 2 a 3 oraciones cortas. No envíes párrafos largos ni listas pesadas.
2. PRODUCTO ÚNICO: Solo vendemos LANDING PAGES (Páginas de aterrizaje). No hacemos e-commerce complejo, pasarelas de pago online ni sistemas de reserva.
3. ENFOQUE Y BENEFICIO: Explicamos que la Landing Page le da a su negocio una imagen 100% profesional para captar más clientes y ventas.
4. MODO DE CONTACTO: Todas las Landing Pages incluyen un botón directo que lleva al cliente desde la web hasta el WhatsApp del negocio con un mensaje automático para cerrar la compra o cotización.

ESTILO:
Amical, directo, vendedor y súper fácil de leer en el celular.
`;

const PROMPT_YAPE = `
Analiza la siguiente imagen y determina si es un comprobante de pago válido de Yape.
Extrae obligatoriamente la siguiente información en formato texto simple:
1. ¿Es un comprobante de Yape válido? (Sí / No)
2. Monto yapeado (S/)
3. Nombre del destinatario
4. Nombre del emisor (si figura)
5. Fecha y hora
6. Nro. de operación
Si no es legible, indica amablemente que no se pudo validar la imagen.
`;

async function procesarMensaje(sock, msg) {
  try {
    const from = msg.key.remoteJid;
    // Ignorar chats de grupos, mensajes enviados por ti mismo o notificaciones del sistema
    if (!from || from.endsWith('@g.us') || msg.key.fromMe) return;

    // OPCIONAL: Descomenta la siguiente línea si deseas ignorar los contactos guardados en tu agenda personal:
    // if (sock.store?.contacts[from]?.name) return;

    const messageType = Object.keys(msg.message)[0];

    // 1. PROCESAR IMÁGENES (Comprobante de Yape)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE] Procesando imagen enviada por ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      const buffer = await sock.downloadMediaMessage(msg);
      const base64Image = buffer.toString('base64');

      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const result = await model.generateContent([
        PROMPT_YAPE,
        {
          inlineData: {
            data: base64Image,
            mimeType: 'image/jpeg'
          }
        }
      ]);

      const respuestaYape = result.response.text();
      await sock.sendMessage(from, { text: respuestaYape });
      return;
    }

    // 2. PROCESAR TEXTO (Asistente de Ventas de Landing Pages)
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      const textoUsuario = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textoUsuario) return;

      console.log(`[VENTAS] Mensaje de ${from}: ${textoUsuario}`);

      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        systemInstruction: PROMPT_VENTAS
      });

      const chat = model.startChat();
      const result = await chat.sendMessage(textoUsuario);
      const respuestaVentas = result.response.text();

      await sock.sendMessage(from, { text: respuestaVentas });
    }
  } catch (error) {
    console.error('Error al procesar el mensaje:', error);
    const from = msg.key?.remoteJid;
    if (from) {
      await sock.sendMessage(from, { 
        text: '¡Hola! En este momento estamos atendiendo varias consultas. Por favor déjanos tu duda sobre nuestras Landing Pages y te responderemos en breve.' 
      });
    }
  }
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false, // Desactiva la sincronización pesada para evitar fallos de buffer
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // Solicitar Código de Emparejamiento por teléfono si la sesión aún no está vinculada
  if (!sock.authState.creds.registered) {
    const numeroTelefono = process.env.BOT_PHONE_NUMBER || "51963737843"; 
    
    setTimeout(async () => {
      const code = await sock.requestPairingCode(numeroTelefono);
      console.log(`\n==================================================`);
      console.log(`CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${code}`);
      console.log(`==================================================\n`);
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        iniciarBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot de WhatsApp conectado exitosamente.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        await procesarMensaje(sock, msg);
      }
    }
  });
}

iniciarBot();