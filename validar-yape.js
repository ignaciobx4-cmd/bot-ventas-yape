require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");

// Toma la API Key de forma segura desde el archivo .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function imagenABase64(path) {
  const file = fs.readFileSync(path);
  return Buffer.from(file).toString("base64");
}

async function verificarYape(rutaImagen) {
  if (!fs.existsSync(rutaImagen)) {
    console.log(`\n⚠️ No se encontró la imagen '${rutaImagen}'. Pónla en la carpeta del proyecto para probar.`);
    return;
  }

  const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });
  const imagenBase64 = imagenABase64(rutaImagen);

  const prompt = `
    Analiza minuciosamente esta captura de pantalla de un pago realizado por YAPE.
    
    Debes verificar y responder en formato JSON estricto con los siguientes campos:
    {
      "es_yape_real": true/false (si tiene el formato legítimo de Yape),
      "monto": número exacto transferido,
      "monto_correcto": true/false (¿es exactamente igual a 175 soles?),
      "fecha": "texto de la fecha detectada",
      "hora": "texto de la hora detectada",
      "numero_operacion": "número de operación si figura",
      "mensaje_validacion": "Explicación breve de si se acepta o rechaza"
    }
  `;

  try {
    console.log("\nAnalizando la captura de Yape con la visión de Gemini...");
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: imagenBase64, mimeType: "image/jpeg" } }
    ]);

    console.log("\n--- RESULTADO DE GEMINI ---");
    console.log(result.response.text());
  } catch (error) {
    console.error("Error al procesar la imagen:", error.message);
  }
}

// Reemplaza esto con el nombre de tu imagen de prueba
verificarYape("comprobante.jpg");