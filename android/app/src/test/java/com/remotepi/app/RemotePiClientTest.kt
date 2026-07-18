package com.remotepi.app

import com.remotepi.app.data.RemotePiException
import com.remotepi.app.network.RemotePiClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class RemotePiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: RemotePiClient
    @Before fun setup() { server = MockWebServer(); server.start(); client = RemotePiClient(server.url("/").toString(), "secret") }
    @After fun close() { server.shutdown() }
    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body)

    @Test fun `adds bearer auth and decodes protocol status`() {
        server.enqueue(json("""{"data":{"version":"0.1.0","protocolVersion":1,"piVersion":"x"}}"""))
        assertEquals(1, client.status().protocolVersion)
        val request = server.takeRequest()
        assertEquals("Bearer secret", request.getHeader("Authorization"))
        assertEquals("1", request.getHeader("X-Remote-Pi-Protocol"))
    }

    @Test fun `websocket request keeps okhttp compatible http scheme`() {
        val request = client.wsRequest()
        assertEquals("http", request.url.scheme)
        assertEquals("/api/v1/ws", request.url.encodedPath)
        assertEquals("Bearer secret", request.header("Authorization"))
        assertEquals("https", RemotePiClient("https://example.com", "token").wsRequest().url.scheme)
    }

    @Test fun `creates workspace with remote path`() {
        server.enqueue(json("""{"data":{"id":"ws-1","label":"Project","rootPath":"/srv/project","createdAt":"now"}}""", 201))
        val workspace = client.addWorkspace("Project", "/srv/project")
        assertEquals("ws-1", workspace.id)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.body.readUtf8().contains("/srv/project"))
    }

    @Test fun `sets session name`() {
        server.enqueue(json("""{"data":{"sessionId":"s1","sessionFile":null,"sessionName":"Review","leafId":null,"entries":[],"tree":[]}}"""))
        assertEquals("Review", client.setSessionName("agent-1", "Review").sessionName)
        assertTrue(server.takeRequest().body.readUtf8().contains("Review"))
    }

    @Test fun `decodes model and thinking capabilities`() {
        server.enqueue(json("""{"data":{"model":{"provider":"p","id":"m"},"models":[{"provider":"p","id":"m"}],"thinkingLevel":"high","thinkingLevels":["off","high"],"supportsThinking":true}}"""))
        val result = client.capabilities("agent-1")
        assertEquals("m", result.model?.id)
        assertEquals("high", result.thinkingLevel)
        assertTrue(result.supportsThinking)
    }

    @Test fun `maps server errors to domain exception`() {
        server.enqueue(json("""{"error":{"code":"MODEL_NOT_FOUND","message":"missing","requestId":"req-1"}}""", 404))
        val error = assertThrows(RemotePiException::class.java) { client.capabilities("agent-1") }
        assertEquals("MODEL_NOT_FOUND", error.code)
        assertEquals("req-1", error.requestId)
    }
}
