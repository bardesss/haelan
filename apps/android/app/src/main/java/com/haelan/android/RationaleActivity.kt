package com.haelan.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import com.google.android.material.button.MaterialButton

/**
 * Shown by Health Connect before its own grant screen. It starts us with an
 * intent, waits for RESULT_OK, and only then shows the permissions to grant.
 * A short explanation and a Continue button is all it takes to satisfy it.
 */
class RationaleActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_rationale)
        findViewById<android.view.View>(R.id.rationaleRoot).padForSystemBars()
        findViewById<MaterialButton>(R.id.buttonContinue).setOnClickListener {
            setResult(RESULT_OK)
            finish()
        }
    }
}
