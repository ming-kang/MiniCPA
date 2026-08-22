import http from "node:http";
import https from "node:https";

export type FixtureHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Local HTTP fixture for tests: starts a server on 127.0.0.1:0, routes by
 * pathname, and always closes in finally. 404s any unrouted path.
 */
export async function withHttpFixture<T>(
  routes: Record<string, FixtureHandler>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("fixture server has no port");
  }

  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

/**
 * Self-signed certificate and private key with SANs for localhost, 127.0.0.1, and ::1,
 * valid for 100 years. Used for testing local TLS readiness probing.
 */
export const TEST_TLS_KEY =
  "-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCw9XBfkc60dCR0\r\nxqwTVXPNfOLDxmEGxTaoRoMH8z1yr2vrxIGqzdu5f+1SvScexsaFN/va5hUTuVVM\r\n62PZuaaQQlSF21eUKMAiv5NU7J4uTnTwrlgTZGyDjbYqIQBafy7X2M75zQW9mE5O\r\nu3A7NhO1vcFwjGReWfoJZNt4fdTVRMuIWcFVe7D3A9iAWND4bz2eTo6akgZkBZYf\r\nBILGxb4oA/jQbu8EqZae/+9bPyylyLDL5GtIfEoh9JFFp56dmMzZn4InFwSUqcIB\r\nEPg7iQnezhoi84D3oCzkDkIgIAOsVVGfmTL96UxB9KpQQa6yw0YgLO5EbdMsfjz/\r\nOyKcKMTVAgMBAAECggEAAcjKdB7qGNYOTg0jdrhxsqc+jsnPzaaBxBWd7vUWxV1x\r\nIaSkHWmg/GWxVMMVLhFutrDXUyA8eIFHE7+l4e/7dtCXE0MgcXKDFCFJZjL9RKtE\r\nMO8ZHUJHI9ZzI/Pxkc1e1rdYHZsMd+/IDlwufV0GEDA/JJg4ejO/D9wv/a7geAa1\r\nbp12ygkJyDJGJebWIP0A+B33qgF6zR5Pc7eH/FWgzsoPJNaBZo8aKyOvxDLGcpwl\r\nXVq5e99N+X3twfQ2qskDlDaX+cclsEJpUqeIO4he8CPPnhPxaxDzhqeYdZadTus3\r\nib0X7Uno95eTb5VRnLucsc3Lj2YJYdfq2KXoykdTkQKBgQDbuAnNa6m96aL32P4P\r\n1GiYgzCr5KFqeXyZum5D2qRJBV461F2EN2OPHeYC1N0J49ttE4xW3RZK1FZH6e2K\r\n0HYA1YGUb7f02wc3LjGBb0uE2pG/GTXX6V9SWrYnnv0hgmpEacs8t6EarzN6nI4U\r\nDfXz+r7rA2M1QsOx/sdbBovmaQKBgQDOLde0k04ttymbDJktSlN+YnxMvJlT0txw\r\n7Az3gENdFagoK1YWIdo/Md8kSf+/LaZAv/4jjgXKT0UXG497bbQOXYl8MkFf4urz\r\nx+NyQM32c/c8aakx3X4nlgQwg7C1RziL1tfXQ7Kw9YW2EIMKQawpockqoNF/SoZN\r\nDwJtcYpVjQKBgEwmmu8hU3FI2nzALj3aRm4leeb5lKBMfszg+np1+t58B86n78l1\r\nUQI3QJLWp81XtaM2VTt94M4KjeTaxMOJwHxFg2Wo2r74cqXDUtEje68N+dmbqTet\r\n4KWwXtWYmu7UPnR7nj7q/eE7u8HRJMT6mbX3v9fAEtBQ1XaJcRqxSCeRAoGAFyXy\r\nd+Wp+1v7IdtSP1F++kuYZQ0vsceU1GDMO+V8qrDJxmjHK4j1de7lfK+KNS6s4cws\r\nflVttP8dZLDFdTgl5Q7/ZqBF0rwpYOFqWeOIvEjc0z2Rr3WMumkPY1sFtfSfFqQy\r\na4rAPznxnzVPYRFqgOoXKeAQZVg6p+Ath5gdzekCgYEAokRVdPeNpBN3LuWEZ0Xk\r\nUV4UiBH/9uk2yThpl3S83SsDcWhpXPqNfXY3wmrX/jKVi6LEpyzhohP7b5d3V7mS\r\nEvuFRuRzTB87LbS4mPrp/hgDAo/vbxW/d5HOODeWErWo0QSDrt9GvSeTRz3CX2O4\r\nzPYDHvxaCG4xEIGa9Hi+Hww=\r\n-----END PRIVATE KEY-----";

export const TEST_TLS_CERT =
  "-----BEGIN CERTIFICATE-----\r\nMIIDLDCCAhSgAwIBAgIUdhZQtfRoasstEcYcuYpMaLvdTPgwDQYJKoZIhvcNAQEL\r\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgyMjE1MzkyNloYDzIxMjYw\r\nNzI5MTUzOTI2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB\r\nAQUAA4IBDwAwggEKAoIBAQCw9XBfkc60dCR0xqwTVXPNfOLDxmEGxTaoRoMH8z1y\r\nr2vrxIGqzdu5f+1SvScexsaFN/va5hUTuVVM62PZuaaQQlSF21eUKMAiv5NU7J4u\r\nTnTwrlgTZGyDjbYqIQBafy7X2M75zQW9mE5Ou3A7NhO1vcFwjGReWfoJZNt4fdTV\r\nRMuIWcFVe7D3A9iAWND4bz2eTo6akgZkBZYfBILGxb4oA/jQbu8EqZae/+9bPyyl\r\nyLDL5GtIfEoh9JFFp56dmMzZn4InFwSUqcIBEPg7iQnezhoi84D3oCzkDkIgIAOs\r\nVVGfmTL96UxB9KpQQa6yw0YgLO5EbdMsfjz/OyKcKMTVAgMBAAGjdDByMA4GA1Ud\r\nDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAsBgNVHREEJTAjgglsb2Nh\r\nbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEwHQYDVR0OBBYEFFiQ4OsarWeq\r\nUd6CVlFMP/KDExtkMA0GCSqGSIb3DQEBCwUAA4IBAQAOaSYh7rCmNpy9ORPDFN/x\r\nRk9ewyX63xSog5EEkS+stJ2jzd6vuqpwYjSbFjlhH17tpj+sAlfITYjHUuiL/TIX\r\n5mKQWMU2v2pbuLc7ffQ5rJSmDObjqJikg8V+We02VVpFOtpPySXh976cgy9IYQoS\r\n1IJXe5dlt+LTuHOa+Ey8c17ViM3p2IH4nsh9Yx78RdlBTK5z4tA4cw9M8ZgSNhvN\r\nK3C4jD1tUsqYu4RO26eEG451WbW/V4Yq795ZtKE7CrGtLt3APmTkmSygouLt5y76\r\ng2ymcvO1kiV4orIYBF0A56xk5b+9QIRxB4IoFJwOnSgR60IeOQzCdkdsToG/IU3o\r\n-----END CERTIFICATE-----";

/**
 * Local HTTPS fixture for tests: starts a TLS server on 127.0.0.1:0 using a
 * self-signed certificate, routes by pathname, and always closes in finally.
 */
export async function withHttpsFixture<T>(
  routes: Record<string, FixtureHandler>,
  fn: (baseUrl: string) => Promise<T>,
  options?: { key?: string; cert?: string },
): Promise<T> {
  const server = https.createServer(
    {
      key: options?.key ?? TEST_TLS_KEY,
      cert: options?.cert ?? TEST_TLS_CERT,
    },
    (req, res) => {
      const pathname = new URL(req.url ?? "/", "https://127.0.0.1").pathname;
      const handler = routes[pathname];
      if (!handler) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      handler(req, res);
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("fixture server has no port");
  }

  try {
    return await fn(`https://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}
