export const defaultPrebuiltMaxUploadBytes = 536870912;
export const defaultPrebuiltMaxUploadFiles = 20000;

function base64DecodedByteLength(value) {
  const normalized = value.trim();

  if (!normalized) {
    return 0;
  }

  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return undefined;
  }

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor(normalized.length * 3 / 4) - padding;
}

function positiveBudgetValue(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function prebuiltUploadStats(files) {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0)
  };
}

export function assertPrebuiltUploadBudget(files, budget, label = "Prebuilt upload") {
  const maxFiles = positiveBudgetValue(budget.maxFiles);
  const maxUploadBytes = positiveBudgetValue(budget.maxUploadBytes);

  if (maxFiles !== undefined && files.length > maxFiles) {
    throw new Error(`${label} exceeds SITEFLOW_PREBUILT_MAX_FILES: ${files.length} > ${maxFiles}.`);
  }

  let totalBytes = 0;

  for (const file of files) {
    const decodedBytes = base64DecodedByteLength(file.contentBase64);

    if (decodedBytes === undefined) {
      throw new Error(`${label} file ${file.path} contentBase64 must be valid base64.`);
    }

    if (decodedBytes !== file.size) {
      throw new Error(`${label} file ${file.path} size does not match decoded content: ${file.size} !== ${decodedBytes}.`);
    }

    totalBytes += decodedBytes;
  }

  if (maxUploadBytes !== undefined && totalBytes > maxUploadBytes) {
    throw new Error(`${label} exceeds SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: ${totalBytes} > ${maxUploadBytes}.`);
  }

  return {
    fileCount: files.length,
    totalBytes
  };
}
