// Top-level build file. Versions live here so the app module has none to drift.
plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    // From Kotlin 2.0 the Compose compiler ships with Kotlin itself, so its version is Kotlin's
    // and the two cannot drift: bump them together.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
}
