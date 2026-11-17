import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyScriptUrl,
  declaresCsp,
  extractScriptTags,
  hasPaymentForm,
  isExternalSrc,
  isPaymentProviderHost,
} from "./browser-scripts-parse.js";

describe("extractScriptTags", () => {
  it("reads src and integrity from HTML, JSX and Next <Script>", () => {
    const text = [
      '<script src="https://a.example/x.js" integrity="sha384-abc"></script>',
      "<script src='//b.example/y.js'></script>",
      '<Script src={"https://c.example/z.js"} onLoad={() => go()} strategy="afterInteractive" />',
      "<script\n  async\n  src=https://d.example/w.js></script>",
      "<script>inline()</script>",
      "<script src={dynamicUrl}></script>",
    ].join("\n");
    assert.deepEqual(extractScriptTags(text), [
      { src: "https://a.example/x.js", integrity: true },
      { src: "//b.example/y.js", integrity: false },
      { src: "https://c.example/z.js", integrity: false },
      { src: "https://d.example/w.js", integrity: false },
    ]);
  });

  it("reads upper- and mixed-case HTML tags and attributes, as browsers do", () => {
    const text =
      '<SCRIPT SRC="https://a.example/x.js" INTEGRITY="sha384-abc"></SCRIPT><ScRiPt sRc=//b.example/y.js>';
    assert.deepEqual(extractScriptTags(text), [
      { src: "https://a.example/x.js", integrity: true },
      { src: "//b.example/y.js", integrity: false },
    ]);
  });

  it("does not read data-src as src", () => {
    assert.deepEqual(extractScriptTags('<script data-src="https://a.example/x.js"></script>'), []);
  });
});

describe("isExternalSrc", () => {
  it("treats http(s) and protocol-relative as external, paths as same-origin", () => {
    assert.equal(isExternalSrc("https://a.example/x.js"), true);
    assert.equal(isExternalSrc("http://a.example/x.js"), true);
    assert.equal(isExternalSrc("//a.example/x.js"), true);
    assert.equal(isExternalSrc("/static/app.js"), false);
    assert.equal(isExternalSrc("./app.js"), false);
    assert.equal(isExternalSrc("app.js"), false);
  });
});

describe("classifyScriptUrl", () => {
  const pin = (src: string) => classifyScriptUrl(src);

  it("flags @latest, missing versions and major ranges on npm CDNs", () => {
    assert.deepEqual(pin("https://unpkg.com/lucide@latest"), {
      host: "unpkg.com",
      pin: "mutable",
      reason: "@latest",
    });
    assert.equal(pin("https://unpkg.com/react/umd/react.production.min.js")?.reason, "no version");
    assert.equal(pin("https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js")?.reason, "range @3");
    assert.equal(
      pin("https://cdn.jsdelivr.net/npm/@scope/pkg@^1.2.0/x.js")?.reason,
      "range @^1.2.0",
    );
    assert.equal(pin("https://cdn.jsdelivr.net/gh/user/repo@main/x.js")?.reason, "@main");
    assert.equal(pin("https://esm.sh/react")?.reason, "no version");
  });

  it("accepts exact versions on npm CDNs and cdnjs", () => {
    assert.equal(pin("https://unpkg.com/react@18.3.1/umd/react.production.min.js")?.pin, "pinned");
    assert.equal(
      pin("https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.0/babel.min.js")?.pin,
      "pinned",
    );
    assert.equal(pin("https://cdn.jsdelivr.net/gh/user/repo@v1.2.3/x.js")?.pin, "pinned");
    assert.equal(pin("//cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js")?.pin, "pinned");
  });

  it("calls any other host a vendor script and rejects junk", () => {
    assert.deepEqual(pin("https://cdn.optimizely.com/js/123.js"), {
      host: "cdn.optimizely.com",
      pin: "vendor",
    });
    assert.equal(pin("https://"), null);
  });
});

describe("hasPaymentForm", () => {
  it("finds cc-* autocomplete and card-named inputs", () => {
    assert.equal(hasPaymentForm('<input autocomplete="cc-number">'), true);
    assert.equal(hasPaymentForm('<input autoComplete="cc-exp-month" />'), true);
    assert.equal(hasPaymentForm('<input name="cardnumber"><input name="cvc">'), true);
    assert.equal(hasPaymentForm('<input id="card-number" type="text">'), true);
    assert.equal(hasPaymentForm('<input name={"cvv"} />'), true);
  });

  it("ignores ordinary forms and card words outside inputs", () => {
    assert.equal(hasPaymentForm('<input name="email" autocomplete="email">'), false);
    assert.equal(hasPaymentForm("<p>Enter your card number and CVC</p>"), false);
  });
});

describe("declaresCsp", () => {
  it("finds a meta tag, header config and helmet()", () => {
    assert.equal(declaresCsp('<meta http-equiv="Content-Security-Policy" content="x">'), true);
    assert.equal(declaresCsp('[[headers]]\n  Content-Security-Policy = "x"'), true);
    assert.equal(declaresCsp("app.use(helmet());"), true);
  });

  it("does not count Report-Only, which enforces nothing", () => {
    assert.equal(declaresCsp('{"key":"Content-Security-Policy-Report-Only"}'), false);
    assert.equal(declaresCsp("<html></html>"), false);
  });
});

describe("isPaymentProviderHost", () => {
  it("knows hosted-field providers, case-insensitively", () => {
    assert.equal(isPaymentProviderHost("js.stripe.com"), true);
    assert.equal(isPaymentProviderHost("JS.Stripe.com"), true);
    assert.equal(isPaymentProviderHost("cdn.optimizely.com"), false);
  });
});
