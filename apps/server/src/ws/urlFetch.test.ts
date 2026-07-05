import http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fetchUrlForTool } from "./urlFetch"

let server: http.Server
let baseUrl = ""

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/page" })
      response.end()
      return
    }
    if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/pdf", "content-length": "8" })
      response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><title>Fetch Test</title><main>Hello from url_fetch</main>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected test server address.")
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    }),
  )
})

describe("fetchUrlForTool", () => {
  it("fetches bounded text and extracts title", async () => {
    const output = await fetchUrlForTool({ url: `${baseUrl}/page`, charLimit: 200 })

    expect(output).toMatchObject({
      url: `${baseUrl}/page`,
      finalUrl: `${baseUrl}/page`,
      status: 200,
      ok: true,
      redirected: false,
      contentType: "text/html; charset=utf-8",
      title: "Fetch Test",
    })
    expect(output.text).toContain("Hello from url_fetch")
    expect(output.truncation.truncated).toBe(false)
  })

  it("reports redirects", async () => {
    const output = await fetchUrlForTool({ url: `${baseUrl}/redirect`, charLimit: 200 })

    expect(output.redirected).toBe(true)
    expect(output.finalUrl).toBe(`${baseUrl}/page`)
    expect(output.text).toContain("Hello from url_fetch")
  })

  it("does not return non-text bodies", async () => {
    const output = await fetchUrlForTool({ url: `${baseUrl}/binary` })

    expect(output).toMatchObject({
      status: 200,
      contentType: "application/pdf",
      contentLength: 8,
      sizeBytes: 0,
    })
    expect(output.text).toBeUndefined()
    expect(output.warnings).toContain("Non-text response body was not returned.")
  })
})
