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

DATOS DEL SERVICIO Y PAGO:
- Producto: Solo vendemos LANDING PAGES (Páginas de aterrizaje profesionales con botón a WhatsApp).
- Precio: S/ 350 (pago único).
- Datos de Yape:
  • Número: 963737843
  • Nombre: Kattia de la Cruz

REGLAS DE RESPUESTA:
1. BREVEDAD EXTREMA: Responde en máximo 2 a 3 oraciones cortas.
2. INSTRUCCIÓN DE PAGO (CLAVE): Si el cliente dice que SÍ quiere comprar, está listo para empezar, o pregunta "¿cómo pago?", "dame el número", "cómo realizo el pago", DEJA de hacer preguntas de venta y dale directamente los datos de Yape:
   "Puedes realizar el Yape de S/ 350 al 963737843 a nombre de Kattia de la Cruz. Envíame la captura o comprobante por aquí para verificarlo e iniciar tu proyecto de inmediato."
3. NO REPETIR PREGUNTAS: Si el cliente ya confirmó que quiere comprar, no le preguntes de nuevo "¿Empezamos?" ni le pidas que escriba por WhatsApp (ya está en WhatsApp).

ESTILO: Amical, directo y profesional.
`;

const PROMPT_YAPE = `
Analiza la siguiente imagen y determina si es un comprobante de pago válido de Yape.
Extrae obligatoriamente la siguiente información en formato texto simple:
1. ¿Es un comprobante de Yape válido? (Sí / No)
2. Monto yapeado (S/)
3. Nombre del destinatario (Debe corresponder o ser similar a Kattia de la Cruz)
4. Nombre del emisor (si figura)
5. Fecha y hora
6. Nro. de operación
Si el pago es válido por S/ 350 a Kattia de la Cruz, indícales que el pago fue verificado con éxito y que en breve iniciaremos la elaboración de su Landing Page.
Si no es legible o no corresponde, indica amablemente que no se pudo validar la imagen.
`;

async function procesarMensaje(sock, msg) {
  try {
    const from = msg.key.remoteJid;
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
        console.warn('[YAPE] Reintentando con modelo alternativo...');
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

    // 2. PROCESAR TEXTO (Asistente de Ventas)
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
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    // Solicitar el código de vinculación únicamente cuando la conexión ya esté lista
    if (!sock.authState.creds.registered && !pairingCodeRequested && (connection === 'connecting' || connection === 'open')) {
      pairingCodeRequested = true;
      let numeroTelefono = (process.env.BOT_PHONE_NUMBER || "51963737843").replace(/[^0-9]/g, '');

      console.log(`[AUTH] Solicitando código de vinculación para: ${numeroTelefono}...`);

      try {
        // Esperar 3 segundos para asegurar que el socket esté listo
        await new Promise(resolve => setTimeout(resolve, 3000));
        const code = await sock.requestPairingCode(numeroTelefono);
        console.log(`\n==================================================`);
        console.log(`CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${code}`);
        console.log(`==================================================\n`);
      } catch (err) {
        console.error("Error al generar el código de vinculación:", err);
        pairingCodeRequested = false;
      }
    }

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