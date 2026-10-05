import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';

// 1. Servidor Express para mantener vivo el proceso en Render
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp activo 24/7');
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});

// 2. Inicializar Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT_VENTAS = `
Eres un asesor de ventas directo, conciso y muy persuasivo para nuestra agencia de desarrollo web.

TUS REGLAS DE ORO:
1. BREVEDAD EXTREMA: Responde SIEMPRE en un máximo de 2 a 3 oraciones cortas. No envíes párrafos largos ni listas pesadas.
2. PRODUCTO ÚNICO: Solo vendemos LANDING PAGES (Páginas de aterrizaje). No hacemos e-commerce complejo, pasarelas de pago online ni sistemas de reserva.
3. PRECIO FIJO: El precio de la Landing Page es SIEMPRE de 350 soles (S/ 350) pago único. Si preguntan costo o precio, diles este valor exacto sin rodeos.
4. ENFOQUE Y BENEFICIO: Explicamos que la Landing Page le da a su negocio una imagen 100% profesional para captar más clientes y ventas.
5. MODO DE CONTACTO: Todas las Landing Pages incluyen un botón directo que lleva al cliente desde la web hasta el WhatsApp del negocio con un mensaje automático para cerrar la compra o cotización.

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
    // Ignorar chats de grupos, mensajes enviados por el propio bot o notificaciones
    if (!from || from.endsWith('@g.us') || msg.key.fromMe) return;

    const messageType = Object.keys(msg.message)[0];

    // 1. PROCESAR IMÁGENES (Comprobante de Yape)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE] Procesando imagen enviada por ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      const buffer = await sock.downloadMediaMessage(msg);
      const base64Image = buffer.toString('base64');

      let result;
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        result = await model.generateContent([
          PROMPT_YAPE,
          { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
        ]);
      } catch (e) {
        console.warn('[YAPE] Reintentando con modelo alternativo por alta demanda...');
        const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
        result = await fallbackModel.generateContent([
          PROMPT_YAPE,
          { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
        ]);
      }

      const respuestaYape = result.response.text();
      await sock.sendMessage(from, { text: respuestaYape });
      return;
    }

    // 2. PROCESAR TEXTO (Asistente de Ventas de Landing Pages)
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      const textoUsuario = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textoUsuario) return;

      console.log(`[VENTAS] Mensaje de ${from}: ${textoUsuario}`);

      let respuestaVentas;
      try {
        const model = genAI.getGenerativeModel({ 
          model: 'gemini-2.5-flash',
          systemInstruction: PROMPT_VENTAS
        });
        const chat = model.startChat();
        const result = await chat.sendMessage(textoUsuario);
        respuestaVentas = result.response.text();
      } catch (e) {
        console.warn('[VENTAS] Reintentando generación con modelo secundario por alta demanda...');
        const fallbackModel = genAI.getGenerativeModel({ 
          model: 'gemini-1.5-flash-latest',
          systemInstruction: PROMPT_VENTAS
        });
        const chatFallback = fallbackModel.startChat();
        const resultFallback = await chatFallback.sendMessage(textoUsuario);
        respuestaVentas = resultFallback.response.text();
      }

      await sock.sendMessage(from, { text: respuestaVentas });
    }
  } catch (error) {
    console.error('Error general al procesar mensaje:', error);
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
    syncFullHistory: false, // Evita descargar chats viejos para prevenir errores de buffer
    markOnlineOnConnect: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on('creds.update', saveCreds);

  // Solicitud de código de vinculación si la sesión aún no existe
  if (!sock.authState.creds.registered) {
    let numeroTelefono = (process.env.BOT_PHONE_NUMBER || "51963737843").replace(/[^0-9]/g, ''); 
    
    console.log(`[AUTH] Solicitando código de vinculación para: ${numeroTelefono}...`);

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(numeroTelefono);
        console.log(`\n==================================================`);
        console.log(`CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${code}`);
        console.log(`==================================================\n`);
      } catch (err) {
        console.error("Error al generar el código de vinculación:", err);
      }
    }, 6000);
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