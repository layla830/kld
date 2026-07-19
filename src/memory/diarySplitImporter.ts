export function cleanImporter(value: string | undefined): string | null {
  const importer = value?.trim().toLowerCase();
  return importer && /^[a-z0-9._-]{1,40}$/.test(importer) ? importer : null;
}
