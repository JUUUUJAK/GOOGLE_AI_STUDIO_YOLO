import { GoogleGenAI, Type } from "@google/genai";
import { BoundingBox, YoloClass } from '../types';

const getBase64FromUrl = async (url: string): Promise<string> => {
  const data = await fetch(url);
  const blob = await data.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      const base64data = reader.result as string;
      // Remove data:image/jpeg;base64, prefix
      resolve(base64data.split(',')[1]);
    };
  });
};

export const autoLabelImage = async (
  imageUrl: string, 
  classes: YoloClass[]
): Promise<BoundingBox[]> => {
  if (!process.env.API_KEY) {
    console.warn("No API Key provided for Gemini");
    return [];
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const base64Image = await getBase64FromUrl(imageUrl);
    
    const classNames = classes.map(c => c.name).join(', ');
    
    const prompt = `
      Identify objects in the image that belong to these classes: ${classNames}.
      Return a list of bounding boxes. 
      For each box, provide the 'class_name', and normalized coordinates 'ymin', 'xmin', 'ymax', 'xmax' (values between 0 and 1).
    `;

    // Use gemini-3-flash-preview for Vision + JSON tasks. 
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview', 
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              class_name: { type: Type.STRING },
              ymin: { type: Type.NUMBER },
              xmin: { type: Type.NUMBER },
              ymax: { type: Type.NUMBER },
              xmax: { type: Type.NUMBER },
            },
            required: ['class_name', 'ymin', 'xmin', 'ymax', 'xmax']
          }
        }
      }
    });

    const rawJson = response.text;
    if (!rawJson) return [];

    const parsedData = JSON.parse(rawJson);
    
    // Map response to our internal BoundingBox format
    // Internal: x (left), y (top), w, h
    const annotations: BoundingBox[] = parsedData.map((item: any) => {
      const matchedClass = classes.find(c => c.name.toLowerCase() === item.class_name.toLowerCase());
      if (!matchedClass) return null;

      const x = item.xmin;
      const y = item.ymin;
      const w = item.xmax - item.xmin;
      const h = item.ymax - item.ymin;

      return {
        id: Math.random().toString(36).substr(2, 9),
        classId: matchedClass.id,
        x,
        y,
        w,
        h,
        isAutoLabel: true // Mark as AI generated
      };
    }).filter((item: any) => item !== null);

    return annotations;

  } catch (error) {
    console.error("Gemini Auto-Label Error:", error);
    throw error;
  }
};