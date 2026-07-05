import type { Instance } from "./model.ts";

const RESERVED_HOST_CHARS = /[^a-z0-9-]+/g;

export const slugifyRepoName = (name: string): string => {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(RESERVED_HOST_CHARS, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base.length === 0 ? "repo" : base;
};

export const composeInstanceSlug = (repoName: string, word: string | null): string => {
  const repo = slugifyRepoName(repoName);
  return word === null ? repo : `${repo}-${slugifyRepoName(word)}`;
};

export const routeHostname = (slug: string, route: string, zone?: string): string => {
  const host = `${slugifyRepoName(slug)}-${slugifyRepoName(route)}`;
  return zone === undefined ? host : `${host}.${zone}`;
};

export const primaryHostname = (slug: string, zone?: string): string => {
  const host = slugifyRepoName(slug);
  return zone === undefined ? host : `${host}.${zone}`;
};

export const instanceHostnames = (
  slug: string,
  instance: Instance,
  zone: string,
): ReadonlyArray<string> => [
  primaryHostname(slug, zone),
  ...Object.keys(instance.ports)
    .filter((route) => route !== instance.routedProcess)
    .sort((left, right) => left.localeCompare(right))
    .map((route) => routeHostname(slug, route, zone)),
];

export const escapeSystemdUnitInstance = (instance: string): string =>
  instance.replace(
    /[^A-Za-z0-9_:.-]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

export const appUnitInstanceName = (slug: string, processName: string): string =>
  escapeSystemdUnitInstance(`${slugifyRepoName(slug)}--${slugifyRepoName(processName)}`);
