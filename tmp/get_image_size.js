const fs = require('fs');
const path = require('path');

// Simple helper to get JPEG dimensions
function getJpegSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  let i = 4;
  while (i < buffer.length) {
    const marker = buffer.readUInt16BE(i);
    i += 2;
    if (marker === 0xFFC0 || marker === 0xFFC2) {
      const height = buffer.readUInt16BE(i + 3);
      const width = buffer.readUInt16BE(i + 5);
      return { width, height };
    } else {
      const length = buffer.readUInt16BE(i);
      i += length;
    }
  }
  return null;
}

try {
  const left = getJpegSize('C:/Users/ADMIN/Desktop/anudeep-kadir-bandi/left-god.jpg');
  const right = getJpegSize('C:/Users/ADMIN/Desktop/anudeep-kadir-bandi/right-god.jpg');
  console.log('Left god size:', left);
  console.log('Right god size:', right);
} catch (e) {
  console.error(e);
}
