import { IMAGE_LIMIT } from './writing-data.js';

export async function prepareImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose or paste a PNG, JPEG, or WebP image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('This image is too large. Use a screenshot smaller than 15 MB.');
  const url = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = url;
    await source.decode();
    if (!source.naturalWidth || !source.naturalHeight || source.naturalWidth * source.naturalHeight > 80_000_000) throw new Error('Crop this large image into smaller screenshots first.');
    const scale = Math.min(1, 1800 / Math.max(source.naturalWidth, source.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare the image.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const fits = value => (value.length - value.indexOf(',') - 1) * 3 / 4 <= IMAGE_LIMIT;
    let data = canvas.toDataURL('image/png');
    if (!fits(data)) data = canvas.toDataURL('image/jpeg', 0.9);
    if (!fits(data)) data = canvas.toDataURL('image/jpeg', 0.75);
    if (!fits(data)) throw new Error('The prepared image is still larger than 2 MB. Crop the screenshot and try again.');
    return data;
  } catch (error) {
    if (error instanceof DOMException) throw new Error('This image could not be read. Try another screenshot.');
    throw error;
  } finally { URL.revokeObjectURL(url); }
}
