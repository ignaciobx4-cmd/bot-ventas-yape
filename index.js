import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inicializar Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT_VENTAS = `
Eres un asistente virtual experto en ventas para nuestra agencia de desarrollo web.
Tu objetivo es brindar información clara sobre creación de páginas web, landing pages y soluciones digitales.
Sé amable, profesional, conciso y orienta al cliente hacia cerrar una venta o consulta.
`;

const PROMPT_YAPE = `
Analiza la siguiente imagen y determina si es un comprobante de pago válido de Yape.
Extrae obligatoriamente la siguiente información en formato texto simple:
1. ¿Es un comprobante de Yape válido? (Sí / No)
2. Monto yapeado (S/)
3. Nombre del destinatario
4. Nombre del emisor (si figura)
5. Fecha y hora de la transacción
6. Nro. de operación
Si no es un comprobante de Yape legible, indica amablemente que no se pudo validar la imagen.
`;

async function procesarMensaje(sock, msg) {
  try {
    const from = msg.key.remoteJid;
    // Evitar responder a mensajes de grupos o del propio bot
    if (!from || from.endsWith('@g.us') || msg.key.fromMe) return;

    const messageType = Object.keys(msg.message)[0];

    // 1. PROCESAR IMÁGENES (Comprobante de Yape)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE] Procesando imagen enviada por ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      // Descargar la imagen del mensaje con Baileys
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

    // 2. PROCESAR TEXTO (Asistente de Ventas)
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      const textoUsuario = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textoUsuario) return;

      console.log(`[VENTAS] Mensaje de ${from}: ${textoUsuario}`);

      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const chat = model.startChat({
        systemInstruction: PROMPT_VENTAS
      });

      const result = await chat.sendMessage(textoUsuario);
      const respuestaVentas = result.response.text();

      await sock.sendMessage(from, { text: respuestaVentas });
    }
  } catch (error) {
    console.error('Error al procesar el mensaje:', error);
  }
}

async function iniciarBot() {
  // Guarda las credenciales de sesión en la carpeta 'auth_info'
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n--- ESCANEA ESTE CÓDIGO QR CON WHATSAPP ---');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
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