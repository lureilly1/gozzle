export interface PackageMetadata {
  version: string;
}

export function readPackageMetadata(): PackageMetadata {
  return {
    version: "0.0.1-canary.0"
  };
}
