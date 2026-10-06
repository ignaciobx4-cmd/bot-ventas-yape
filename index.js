import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';

// 1. Servidor Express para mantener vivo el servicio en Render
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp Inteligente activo 24/7');
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});

// 2. Configuración de Variables
const MI_NUMERO_NOTIFICACION = '51963737843@s.whatsapp.net';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Palabras clave para detectar intención comercial
const PALABRAS_CLAVE_WEB = ['web', 'landing', 'pagina', 'página', 'precio', 'cotizacion', 'cotización', 'portafolio', 'ejemplo', 'diseño', 'desarrollo', 'yape', 'cuanto', 'cuánto', 'interesado', 'listo'];
const chatsActivosBot = new Set();

// Memoria en vivo para almacenar el historial conversacional reciente por cliente (Máximo 10 mensajes por chat)
const historialConversaciones = new Map();

// MODELOS RESPALDO PARA OPENROUTER
const MODELOS_OPENROUTER = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
  'google/gemini-2.0-flash-exp:free'
];

const PROMPT_VENTAS_SISTEMA = `
Eres el asesor de ventas principal y mano derecha de Ignacio en nuestra agencia de desarrollo web. Tu objetivo es ser extremadamente fluido, inteligente y natural al continuar la conversación con el cliente.

CONTEXTO DE NUESTROS SERVICIOS Y PRECIOS:
- Producto: Vendemos exclusivamente LANDING PAGES profesionales (Páginas de aterrizaje a la medida, diseñadas desde cero, optimizadas para ventas con botón directo a WhatsApp).
- Precio Oficial: S/ 350 (Pago único).
- Modalidad de Pago: Pago total de S/ 350 o un adelanto del 50% (S/ 175) para iniciar el diseño y el 50% restante contra entrega.
- Datos de Yape para Pago:
  • Número Yape: 963737843
  • Titular: Kattia de la Cruz

NUESTRO PORTAFOLIO DE TRABAJOS:
Si el cliente solicita ver trabajos anteriores, ejemplos o portafolio, compártele estos enlaces:
- 🏗️ Arquiduo Studio (Arquitectura): https://arquiduo-studio.web.app
- 🛍️ Click & Go Perú (Skincare / Catálogo): https://clickandgo-pe.netlify.app
- 🔧 Soluciones Rápidas (Servicio Técnico): https://soluciones-linea-blanca.web.app
- 💆 Joyas Spa (Spa / Masajes): https://joyas-spa.web.app
Menciona siempre que cada sitio se crea 100% personalizado para su marca.

REGLAS INTELIGENTES DE COMPORTAMIENTO:
1. CONTINUIDAD Y CONTEXTO: Lee el historial previo antes de responder. Si el cliente o el asesor humano ya habían hablado antes sobre la página web o el interés en el proyecto, retoma la conversación de manera natural.
2. DISPOSICIÓN Y CIERRE DIRECTO DE VENTA: Si el cliente dice expresiones como "sí estoy interesado", "ya estoy listo", "dame los datos", "cómo hacemos para empezar", "mándame el Yape" o similares:
   - VE DIRECTO AL PAGO Y CIERRA LA VENTA en un solo mensaje claro y amable.
   - Pauta exactamente esto:
     "¡Excelente! Podemos empezar de inmediato. Puedes realizar el pago total de S/ 350 o el adelanto del 50% (S/ 175) al Yape 963737843 a nombre de Kattia de la Cruz. Apenas realices el Yape, reenvíame el comprobante por aquí para verificarlo e iniciar tu proyecto."
3. RESPUESTA A PREGUNTAS TÉCNICAS O DUDAS: Si el cliente hace preguntas sobre qué incluye, tiempos de entrega o funcionamiento, respóndelas amablemente en 2 o 3 oraciones cortas y finaliza preguntándole si está listo para empezar.
4. TONO PROFESIONAL Y DIRECTO: No des explicaciones largas. Máximo 2 a 3 oraciones por respuesta.
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

Si el pago es válido por S/ 175 o S/ 350 a Kattia de la Cruz:
Indícale amablemente al cliente que el pago fue verificado con éxito y pídele que envíe en un solo mensaje:
1. Nombre de su negocio.
2. Descripción breve de sus productos o servicios.
3. Enlace a sus redes sociales (Instagram/Facebook) o logo para iniciar.
Si no es legible o no corresponde, indica amablemente que no se pudo validar la imagen.
`;

/**
 * Guarda el mensaje en el historial contextual del cliente
 */
function guardarEnHistorial(chatId, role, content) {
  if (!historialConversaciones.has(chatId)) {
    historialConversaciones.set(chatId, []);
  }
  const historial = historialConversaciones.get(chatId);
  historial.push({ role, content });

  // Mantener solo los últimos 10 mensajes para ahorrar contexto y tokens
  if (historial.length > 10) {
    historial.shift();
  }
}

/**
 * Descarga una imagen enviada por WhatsApp en un Buffer seguro
 */
async function descargarImagenBuffer(msg) {
  try {
    const imageMessage = msg.message?.imageMessage;
    if (!imageMessage) return null;

    const stream = await downloadContentFromMessage(imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer.length > 0 ? buffer : null;
  } catch (error) {
    console.error('Error al descargar el buffer de la imagen:', error);
    return null;
  }
}

/**
 * 1ª Opción Principal: Groq Cloud (llama-3.1-8b-instant) enviando historial completo
 */
async function consultarGroqCloud(chatId) {
  if (!GROQ_API_KEY) {
    console.warn('[GROQ] GROQ_API_KEY no configurada en las variables de entorno.');
    return null;
  }

  const historialChat = historialConversaciones.get(chatId) || [];
  const messagesPayload = [
    { role: 'system', content: PROMPT_VENTAS_SISTEMA },
    ...historialChat
  ];

  try {
    console.log(`[GROQ] Consultando con historial completo de ${chatId}...`);
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messagesPayload,
        temperature: 0.4,
        max_tokens: 300
      })
    });

    if (response.ok) {
      const data = await response.json();
      const respuesta = data.choices[0]?.message?.content;
      if (respuesta) {
        console.log('✅ [GROQ] Respuesta contextual generada exitosamente.');
        return respuesta;
      }
    }

    const errorTexto = await response.text();
    console.warn('[GROQ] Falló la llamada a Groq. Detalle:', errorTexto);
  } catch (err) {
    console.error('[GROQ] Error de conexión con Groq:', err);
  }

  return null;
}

/**
 * 2ª Opción (Fallback): OpenRouter con envío de historial completo
 */
async function consultarOpenRouterGratuito(chatId) {
  const historialChat = historialConversaciones.get(chatId) || [];
  const messagesPayload = [
    { role: 'system', content: PROMPT_VENTAS_SISTEMA },
    ...historialChat
  ];

  for (const modelo of MODELOS_OPENROUTER) {
    try {
      console.log(`[OPENROUTER FALLBACK] Intentando con modelo: ${modelo}`);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://landing-pages.web.app',
          'X-Title': 'Bot WhatsApp Ventas'
        },
        body: JSON.stringify({
          model: modelo,
          messages: messagesPayload
        })
      });

      if (response.ok) {
        const data = await response.json();
        const respuesta = data.choices[0]?.message?.content;
        if (respuesta) {
          console.log(`✅ [OPENROUTER] Respuesta generada con éxito de: ${modelo}`);
          return respuesta;
        }
      }

      const errorDetalle = await response.text();
      console.warn(`[OPENROUTER] Modelo ${modelo} falló. Detalle:`, errorDetalle);
    } catch (err) {
      console.error(`[OPENROUTER] Error conectando con ${modelo}:`, err);
    }
  }

  console.error('❌ [OPENROUTER] Todos los modelos de respaldo fallaron.');
  return null;
}

/**
 * Gestor inteligente para mensajes de texto
 */
async function obtenerRespuestaVentas(chatId) {
  let respuesta = await consultarGroqCloud(chatId);
  
  if (!respuesta) {
    console.warn('⚠️ [SISTEMA] Groq falló. Activando respaldo de OpenRouter...');
    respuesta = await consultarOpenRouterGratuito(chatId);
  }

  return respuesta;
}

/**
 * Notificación a tu WhatsApp personal
 */
async function notificarPedidoAAdmin(sock, datos) {
  const mensajeFicha = `
🚨 *NUEVO PEDIDO O SEGUIMIENTO REGISTRADO* 🚨
==================================
👤 *Cliente:* ${datos.nombreCliente}
📱 *WhatsApp:* https://wa.me/${datos.telefono}

💰 *DETALLES DEL PAGO / ESTADO:*
• *Mensaje/Monto:* ${datos.monto}

🏢 *INFORMACIÓN PROPORCIONADA:*
"${datos.detalleCliente}"

==================================
📌 *Acción requerida:* Revisar el chat en WhatsApp para proceder con el maquetado de la Landing Page.
`;

  try {
    await sock.sendMessage(MI_NUMERO_NOTIFICACION, { text: mensajeFicha });
    console.log('✅ Notificación enviada a tu WhatsApp personal.');
  } catch (error) {
    console.error('Error al enviar la notificación al admin:', error);
  }
}

async function procesarMensaje(sock, msg) {
  try {
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    if (!from || from.endsWith('@g.us')) return;

    const isFromMe = msg.key.fromMe;
    const numeroRemitente = from.replace(/[^0-9]/g, '');
    const timestampMensaje = (msg.messageTimestamp || Date.now() / 1000) * 1000;
    const diezDiasEnMs = 10 * 24 * 60 * 60 * 1000;
    const ahora = Date.now();

    const messageType = Object.keys(msg.message)[0];
    const textoUsuario = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const textoMinuscula = textoUsuario.toLowerCase();

    // SI EL MENSAJE LO ENVIAS TÚ MISMO (IGNACIO) A UN CLIENTE:
    // Guardamos tu mensaje en el historial del cliente para que el bot entienda lo que tú le dijiste.
    if (isFromMe) {
      if (textoUsuario) {
        guardarEnHistorial(from, 'assistant', textoUsuario);
        console.log(`[HISTORIAL HUMANO] Registrado mensaje de Ignacio para ${from}: "${textoUsuario}"`);
      }
      return;
    }

    const tieneContextoWeb = PALABRAS_CLAVE_WEB.some(palabra => textoMinuscula.includes(palabra));

    // Filtro de contexto o antigüedad
    if (!chatsActivosBot.has(from)) {
      if (ahora - timestampMensaje > diezDiasEnMs && !tieneContextoWeb) {
        console.log(`[IGNORADO] Chat antiguo (>10 días) sin contexto web: ${numeroRemitente}`);
        return;
      }
      chatsActivosBot.add(from);
    }

    // 1. PROCESAR IMÁGENES (Yape / Gemini)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE - GEMINI] Procesando imagen de ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      const buffer = await descargarImagenBuffer(msg);
      if (!buffer) {
        await sock.sendMessage(from, { text: '⚠️ No se pudo procesar la imagen enviada. Por favor, vuelve a enviarla.' });
        return;
      }

      const base64Image = buffer.toString('base64');
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent([
        PROMPT_YAPE,
        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
      ]);

      const respuestaYape = result.response.text();
      await sock.sendMessage(from, { text: respuestaYape });

      guardarEnHistorial(from, 'user', '[El cliente envió una imagen/comprobante de Yape]');
      guardarEnHistorial(from, 'assistant', respuestaYape);

      if (respuestaYape.toLowerCase().includes('sí') || respuestaYape.toLowerCase().includes('éxito')) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: numeroRemitente,
          monto: '175 / 350 (Comprobante Recibido)',
          detalleCliente: 'Comprobante de Yape verificado por Gemini.'
        });
      }
      return;
    }

    // 2. PROCESAR TEXTO DEL CLIENTE
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      if (!textoUsuario) return;

      console.log(`[VENTAS ENTRANTE] Mensaje de ${from}: ${textoUsuario}`);

      // Registrar mensaje entrante del cliente en el historial
      guardarEnHistorial(from, 'user', textoUsuario);

      // Obtener respuesta contextual procesando todo el historial
      const respuestaVentas = await obtenerRespuestaVentas(from);

      if (respuestaVentas) {
        await sock.sendMessage(from, { text: respuestaVentas });
        // Registrar respuesta enviada por el bot
        guardarEnHistorial(from, 'assistant', respuestaVentas);
      }

      // Notificar si el cliente proporciona datos del proyecto o confirma compra
      if (textoUsuario.length > 20 && (textoUsuario.toLowerCase().includes('negocio') || textoUsuario.toLowerCase().includes('listo') || textoUsuario.toLowerCase().includes('http') || textoUsuario.toLowerCase().includes('instagram'))) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: numeroRemitente,
          monto: 'Interés / Cierre de venta',
          detalleCliente: textoUsuario
        });
      }
    }
  } catch (error) {
    console.error('Error capturado en procesarMensaje:', error);
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

  let codigoSolicitado = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (!sock.authState.creds.registered && !codigoSolicitado && (qr || connection === 'connecting')) {
      codigoSolicitado = true;
      let numeroTelefono = (process.env.BOT_PHONE_NUMBER || "51963737843").replace(/[^0-9]/g, '');

      console.log(`\n[AUTH] Generando código de vinculación para: ${numeroTelefono}...`);

      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(numeroTelefono);
          console.log(`\n==================================================`);
          console.log(`CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${code}`);
          console.log(`==================================================\n`);
        } catch (err) {
          console.error("Error al generar el código de vinculación:", err);
          codigoSolicitado = false;
        }
      }, 4000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        iniciarBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot de WhatsApp inteligente conectado exitosamente.');
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