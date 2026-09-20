package com.haelan.android

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.activity.ComponentActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Sign-in screen, mirroring the web SignIn copy and behaviour: the same two
 * failure messages (wrong credentials vs instance unreachable), and the same
 * session-expired notice when landing here after a 401 elsewhere.
 */
class LoginActivity : ComponentActivity() {

    companion object {
        const val EXTRA_EXPIRED = "expired"
        const val EXTRA_SERVER = "server"
        const val EXTRA_PERSON_ID = "personId"
        const val EXTRA_COOKIE = "cookie"
        const val EXTRA_USERNAME = "username"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun startMain(session: SessionStore.Session) {
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_SERVER, session.server)
            putExtra(EXTRA_PERSON_ID, session.personId)
            putExtra(EXTRA_COOKIE, session.cookie)
            putExtra(EXTRA_USERNAME, session.username)
        })
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val stored = SessionStore.prefs(this)
        // The app lives on the phone: if a saved session exists, it signs in on its own.
        SessionStore.loadSession(stored)?.let {
            startMain(it)
            return
        }

        setContentView(R.layout.activity_login)
        findViewById<android.view.View>(R.id.loginRoot).padForSystemBars()
        val serverField = findViewById<TextInputEditText>(R.id.serverUrl)
        val usernameField = findViewById<TextInputEditText>(R.id.username)
        val passwordField = findViewById<TextInputEditText>(R.id.password)
        val error = findViewById<TextView>(R.id.loginError)
        val expired = findViewById<TextView>(R.id.loginExpired)
        val button = findViewById<MaterialButton>(R.id.buttonSignIn)

        val (savedServer, savedUsername) = SessionStore.serverAndUsername(stored)
        serverField.setText(savedServer)
        usernameField.setText(savedUsername)
        if (intent.getBooleanExtra(EXTRA_EXPIRED, false)) expired.visibility = View.VISIBLE
        if (SessionStore.insecureFallback) {
            error.setText(R.string.login_insecure)
            error.visibility = View.VISIBLE
        }

        button.setOnClickListener {
            // The address is repaired here and only here, before it is saved: every request the
            // app makes afterwards is built from the stored form.
            val server = InstanceAddress.normalize(serverField.text.toString())
            val username = usernameField.text.toString().trim()
            val password = passwordField.text.toString()
            if (server == null) {
                error.setText(R.string.login_server_invalid)
                error.visibility = View.VISIBLE
                return@setOnClickListener
            }
            if (username.isEmpty() || password.isEmpty()) {
                error.setText(R.string.login_failed)
                error.visibility = View.VISIBLE
                return@setOnClickListener
            }
            error.visibility = View.GONE
            button.isEnabled = false
            button.setText(R.string.login_working)
            scope.launch {
                val result = withContext(Dispatchers.IO) { tryLogin(server, username, password) }
                button.isEnabled = true
                button.setText(R.string.login_submit)
                when (result) {
                    is LoginResult.Ok -> {
                        SessionStore.saveSession(stored, server, username, result.personId, result.cookie)
                        startMain(SessionStore.Session(server, result.personId, result.cookie, username))
                    }
                    is LoginResult.Failed -> {
                        error.text = if (result.status != null) getString(result.messageRes, result.status)
                        else getString(result.messageRes)
                        error.visibility = View.VISIBLE
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private sealed interface LoginResult {
        data class Ok(val personId: String, val cookie: String) : LoginResult
        // status rides along only so error_instance can name the answer: strings without a
        // placeholder ignore the extra argument, so every other sentence prints unchanged.
        data class Failed(val messageRes: Int, val status: Int? = null) : LoginResult
    }

    private fun tryLogin(server: String, username: String, password: String): LoginResult {
        val body = JSONObject().put("username", username).put("password", password).toString()
        // Both things this screen needs come out of one reply, which is why the client hands the
        // whole answer to the parser instead of a body: the person id is in the JSON and the
        // cookie is in a header, and a caller that got only one of them would have to ask twice.
        val loggedIn = InstanceClient.post(server, "/api/auth/login", body) { reply ->
            val personId = JSONObject(reply.body).optString("personId").takeIf { it.isNotEmpty() }
            // The cookie's name is spelled once, in the client, so this screen and the server
            // cannot disagree about which cookie is the session.
            val cookie = reply.cookie(InstanceClient.SESSION_COOKIE)
            if (personId == null || cookie == null) null else personId to cookie
        }
        // Every non-200 is "these credentials did not work" here only for 401, whichever
        // half was wrong, the same sentence the web client uses. Any other answer keeps the
        // instance's own reason, with its status so the sentence can name it. The sync reads
        // the same statuses as its own cases.
        return when (loggedIn) {
            is InstanceClient.Outcome.Ok -> loggedIn.value
                ?.let { (personId, cookie) -> LoginResult.Ok(personId, cookie) }
                ?: LoginResult.Failed(R.string.login_failed)
            is InstanceClient.Outcome.Failed -> {
                val status = (loggedIn.error as? InstanceClient.InstanceHttpException)?.status
                LoginResult.Failed(InstanceError.forLogin(loggedIn.error), status)
            }
        }
    }
}
