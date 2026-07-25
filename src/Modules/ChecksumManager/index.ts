import checksum from 'checksum';

interface ChecksumManager {
  /** Resolves the file's checksum, or `undefined` when the file is unreadable. */
  Checksum(filePath: string): Promise<string | undefined>;
}

export const Manager: ChecksumManager = {
  Checksum: async (filePath) => {
    return new Promise((resolve, _reject) => {
      checksum.file(filePath, function (_err, sum) {
        return resolve(sum);
      });
    });
  },
};
