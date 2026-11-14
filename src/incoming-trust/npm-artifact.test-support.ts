// Fixed Python stdlib vectors: USTAR, gzip mtime zero, SHA-512. No package code runs.
export const artifactVectors = {
  valid: {
    base64:
      "H4sIAAAAAAAC/+3TwWoCMRAG4Jx9ijCnCmV3sy4r6KWX3n2FEAfddk2WJNaC+O5OVRC8eBFp6f9dJpkcApP8g3WfdsXlcK7FRwpePVgl2qY5VXFbK1Nf16e+Ma2ZKl2pJ9imbKNcr/6nPXm7YZrRW3Jh4DKy7emVvjimLnjpm6IuJtJJLnZDTjTbU+dlZn0vhz4sWV+28nXocFDwp1xyX14f8fF33Mt/1da3+Z80NfL/DHkdw0573un3GEN8ocX5Q2j3E+2NTEf7kDV/s9tmpvF8hMwAAAAAAAAAAAAAAAAAAAAA/CZH0yRf8gAoAAA=",
    integrity:
      "sha512-pXIrUXqhJAP57CrKRI8I6WnaGSE5qxjlL9GzG0rVDY1maQZwzZh1Kqd+lPVMNjt7ye6X/m8LPKmkXXtAnvPtlw==",
    compressedBytes: 239,
    uncompressedBytes: 10240,
    entryCount: 2,
  },
  wrongName: {
    base64:
      "H4sIAAAAAAAC/+3TvWrDMBRAYc19CqGpgeJ/PCRz97yCcETr1paMLNeBkHevGhcKXrqEUJrzLVfcRSB0Bt286xeTDstM3kZnxZVlUV1VlxmtZ5ZV5c/5a5/ndVEKmYkbmMagfbxe3KeTsro3aqsa1w86qCf1YfzYOhtXeVIkpToL/F/f3aetjR10Xez/+nf82n9drPsvq4L+byG8ejdLa2b57L3zj2q/fAjZuIORfXwdaV2Q5miaKRi12T3QDAAAAAAAAAAAAAAAwF/yCSCpGmgAKAAA",
    integrity:
      "sha512-YrtxG2vqWJQR1TVDm6RW4dpiXtLg1HKY42/7PbxKS/tzwdEkwYhEV+c1fDrObeoiQCTtgAAZ1FYF8ghHAhOp2Q==",
    compressedBytes: 213,
    uncompressedBytes: 10240,
    entryCount: 2,
  },
  wrongVersion: {
    base64:
      "H4sIAAAAAAAC/+3Tu27CMBSAYc99CstTkVBuhAx06cLeV7DCEbdgR064SKjvXhcYEAsLQqj9v+VYZ7Fk+W9tvbZzSdvzTFadd+rBsqgqy9OMbmeWja/Ov/s8r4pc6Uw9wbbrbYjXq//paJzdiJmYz672raRBbGOGZiehW3oX93lSJKX5VviTLt2nSxc7aJrY/+PvuNt/Vdz2PyoL+n+GfhH8XjvZ62kIPrybr/OH0LWfid7E19HO91oOUm97MYOPN5oBAAAAAAAAAAAAAAB4JT+2GwFPACgAAA==",
    integrity:
      "sha512-YqWjc4JrdGN5nMTN7dkc6CzvUpvrGW/TKDNQfnuQDCsSNP5bqP9dZ/u9GDmaAQ1r8A1FX4Rh8ReYVJ4W5Jt8+Q==",
    compressedBytes: 217,
    uncompressedBytes: 10240,
    entryCount: 2,
  },
  invalidScripts: {
    base64:
      "H4sIAAAAAAAC/+3TsYoCMRAG4NT3FGEqD2Q3WZct1uYae18hxEH3XJMlyZ6C+O4GlStsbEQ87v+aCdMMTOYfjN2aNZfDtRbf0TvxZCpr6vpSs/uqtNK/70tf60Y3QirxAmNMJuTx4n86kjM7ppa+ovUDl4FNT1P64RA773JfF1Uxy51oQzekSO2ROpd31vfU1tXpJOAvu+W+vP1pzv/zZzzKv2qq+/zP6gr5f4W0CX4vHe/lIgQfJrS8HoS0fsVyl7cjnU+SD2zHxPQ5/0BmAAAAAAAAAAAAAAAAAAAAAN7JGe/jE8QAKAAA",
    integrity:
      "sha512-h3VsO5Zvv5yFTBn5m4kgBWYvHJfB3nGraOtKKrBzXfRerzniwAjlybaQeDPcriUHL9JisHBv3cij48C8dpxtPA==",
    compressedBytes: 234,
    uncompressedBytes: 10240,
    entryCount: 2,
  },
} as const;
