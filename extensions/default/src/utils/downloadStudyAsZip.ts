import type { StudyMetadata } from '@ohif/core/types';
import { zipSync } from 'fflate';

type RetrieveInstanceFn = (options: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  withCredentials?: boolean;
}) => Promise<ArrayBuffer>;

type DownloadStudyOptions = {
  StudyInstanceUID: string;
  studyMetadata: StudyMetadata;
  retrieveInstance: RetrieveInstanceFn;
  withCredentials?: boolean;
};

type DownloadResult = {
  fileName: string;
  count: number;
};

function sanitizeString(value: unknown, fallback: string): string {
  if (value == null) {
    return fallback;
  }

  let stringValue: string | undefined;

  if (typeof value === 'string' && value.trim().length > 0) {
    stringValue = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    stringValue = value.toString();
  } else if (typeof value === 'object') {
    const candidate = extractStringFromObject(value);
    if (candidate) {
      stringValue = candidate;
    }
  }

  if (!stringValue) {
    return fallback;
  }

  const normalized = stringValue
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);

  return normalized || fallback;
}

function extractStringFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('Alphabetic' in (value as Record<string, unknown>)) {
    const alpha = (value as Record<string, unknown>).Alphabetic;
    if (typeof alpha === 'string') {
      return alpha;
    }
    if (Array.isArray(alpha) && typeof alpha[0] === 'string') {
      return alpha[0];
    }
  }

  if ('Value' in (value as Record<string, unknown>)) {
    const val = (value as Record<string, unknown>).Value;
    if (typeof val === 'string') {
      return val;
    }
    if (Array.isArray(val) && typeof val[0] === 'string') {
      return val[0];
    }
  }

  const objectValues = Object.values(value as Record<string, unknown>);
  for (const candidate of objectValues) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const text = candidate.find(item => typeof item === 'string');
      if (typeof text === 'string') {
        return text;
      }
    }
  }

  return undefined;
}

function padNumber(value: unknown, fallbackIndex: number, length: number): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric).toString().padStart(length, '0');
  }

  return Math.trunc(fallbackIndex).toString().padStart(length, '0');
}

function ensureUnique(base: string, used: Set<string>): string {
  let candidate = base || 'Item';
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  let suffix = 1;
  while (used.has(`${candidate}_${suffix}`)) {
    suffix += 1;
  }
  const uniqueName = `${candidate}_${suffix}`;
  used.add(uniqueName);
  return uniqueName;
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Downloads are only supported in a browser environment.');
  }

  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

export default async function downloadStudyAsZip({
  StudyInstanceUID,
  studyMetadata,
  retrieveInstance,
  withCredentials = false,
}: DownloadStudyOptions): Promise<DownloadResult> {
  if (!studyMetadata) {
    throw new Error('Study metadata is not available for download.');
  }

  if (typeof retrieveInstance !== 'function') {
    throw new Error('Active data source does not support instance retrieval.');
  }

  const seriesList = Array.isArray(studyMetadata.series) ? studyMetadata.series : [];
  const totalInstances = seriesList.reduce((sum, series) => {
    const instances = Array.isArray(series?.instances) ? series.instances : [];
    return sum + instances.length;
  }, 0);

  if (!totalInstances) {
    throw new Error('The selected study does not contain any retrievable instances.');
  }

  const files: Record<string, Uint8Array> = {};
  const usedSeriesFolders = new Set<string>();
  const usedPaths = new Set<string>();

  for (let seriesIndex = 0; seriesIndex < seriesList.length; seriesIndex++) {
    const series = seriesList[seriesIndex];
    const instances = Array.isArray(series?.instances) ? series.instances : [];

    if (!instances.length) {
      continue;
    }

    const paddedSeriesNumber = padNumber(series?.SeriesNumber, seriesIndex + 1, 2);
    const seriesDescription = sanitizeString(
      series?.SeriesDescription ?? series?.Modality ?? `Series${seriesIndex + 1}`,
      `Series${seriesIndex + 1}`,
    );

    const seriesFolder = ensureUnique(`${paddedSeriesNumber}_${seriesDescription}`, usedSeriesFolders);

    for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex++) {
      const instance = instances[instanceIndex];
      const sopInstanceUID = instance?.SOPInstanceUID;
      const seriesInstanceUID = series?.SeriesInstanceUID;

      if (!sopInstanceUID || !seriesInstanceUID) {
        throw new Error('Study metadata is missing identifiers required for retrieval.');
      }

      let datasetBuffer: ArrayBuffer;
      try {
        datasetBuffer = await retrieveInstance({
          studyInstanceUID: StudyInstanceUID,
          seriesInstanceUID,
          sopInstanceUID,
          withCredentials,
        });
      } catch (error) {
        const reason = (error as Error)?.message ?? 'Unknown error';
        throw new Error(`Failed to retrieve instance ${sopInstanceUID}: ${reason}`);
      }

      const paddedInstanceNumber = padNumber(instance?.InstanceNumber, instanceIndex + 1, 4);
      const baseFileName = `${paddedInstanceNumber}_${sanitizeString(
        sopInstanceUID,
        `Instance${instanceIndex + 1}`,
      )}`;

      let relativePath = `${seriesFolder}/${baseFileName}.dcm`;
      if (usedPaths.has(relativePath)) {
        let suffix = 1;
        while (usedPaths.has(`${seriesFolder}/${baseFileName}_${suffix}.dcm`)) {
          suffix += 1;
        }
        relativePath = `${seriesFolder}/${baseFileName}_${suffix}.dcm`;
      }

      usedPaths.add(relativePath);
      files[relativePath] = new Uint8Array(datasetBuffer);
    }
  }

  if (Object.keys(files).length === 0) {
    throw new Error('No instances were retrieved for download.');
  }

  const zipData = zipSync(files, { level: 6 });

  const patientName = sanitizeString(
    extractStringFromObject(studyMetadata.PatientName) ?? studyMetadata.PatientName,
    '',
  );
  const studyDescription = sanitizeString(studyMetadata.StudyDescription, StudyInstanceUID);
  const studyDate = sanitizeString(studyMetadata.StudyDate, '');

  const fileBase = [patientName, studyDescription, studyDate]
    .filter(Boolean)
    .join('_');

  const sanitizedBase = sanitizeString(fileBase, StudyInstanceUID);
  const fileName = `${sanitizedBase || StudyInstanceUID}.zip`;

  const blob = new Blob([zipData], { type: 'application/zip' });
  triggerBrowserDownload(blob, fileName);

  return { fileName, count: Object.keys(files).length };
}
