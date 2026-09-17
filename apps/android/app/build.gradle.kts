import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The palette is a target of @haelan/tokens and reaches this module as generated resources: no
// colour in res/ is written by hand, and the two files are an output like any other, which is why
// they belong under build/ rather than in the source tree (T7.1).
val tokensRes = layout.buildDirectory.dir("haelan-tokens/res")
val tokensColorFiles = listOf("values/colors.xml", "values-night/colors.xml")

// An Android build does not run a Node toolchain, so this fails instead of generating, and it fails
// with the command that fixes it rather than with aapt's opinion about a missing resource.
val checkTokensGenerated = tasks.register("checkTokensGenerated") {
    val res = tokensRes
    val required = tokensColorFiles
    doLast {
        val missing = required.filterNot { res.get().file(it).asFile.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "the token palette has not been generated (${missing.joinToString(", ")} missing). " +
                    "From the repository root, run: pnpm --filter @haelan/tokens build:android",
            )
        }
    }
}

// The file name carries the same base as the applicationId: haelan-android-debug.apk
// instead of the module default app-debug.apk.
base {
    archivesName.set("haelan-android")
}

// Release signing (T8.1): the key never enters the repository. The owner mints it once and
// hands it to CI through four variables (the runbook lives in TASKS.md T8.1); a release build
// without them fails below with the fix, instead of shipping an unsigned APK that looks fine.
// A local .env file fills the same four values on the owner's machine; real environment
// variables always win, so CI needs no file. The file is git-ignored and must stay that way:
// it holds the key in plain text by design, for one machine only. No dotenv dependency for
// four lines: KEY=VALUE, blanks and # comments skipped, single or double quotes stripped.
val localEnv: Map<String, String> = rootDir.resolve(".env")
    .takeIf { it.isFile }
    ?.readLines()
    .orEmpty()
    .map { it.trim() }
    .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains("=") }
    .associate { line ->
        line.substringBefore("=").trim() to
            line.substringAfter("=").trim().removeSurrounding("\"").removeSurrounding("'")
    }

fun signingVar(name: String): String? =
    System.getenv(name)?.takeIf { it.isNotEmpty() } ?: localEnv[name]?.takeIf { it.isNotEmpty() }

val releaseSigningVars = listOf(
    "HAELAN_KEYSTORE_BASE64" to signingVar("HAELAN_KEYSTORE_BASE64"),
    "HAELAN_KEYSTORE_PASSWORD" to signingVar("HAELAN_KEYSTORE_PASSWORD"),
    "HAELAN_KEY_ALIAS" to signingVar("HAELAN_KEY_ALIAS"),
    "HAELAN_KEY_PASSWORD" to signingVar("HAELAN_KEY_PASSWORD"),
)
val releaseKeystoreBase64 = releaseSigningVars[0].second

fun releaseSigningError(): Nothing = throw GradleException(
    "release signing is not configured: set HAELAN_KEYSTORE_BASE64, HAELAN_KEYSTORE_PASSWORD, " +
        "HAELAN_KEY_ALIAS and HAELAN_KEY_PASSWORD as environment variables, or list them in " +
        "apps/android/.env (see .env.example). TASKS.md T8.1 tells the owner how to mint them. " +
        "Debug builds need none of this.",
)

android {
    namespace = "com.haelan.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.haelan.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        create("release") {
            if (releaseSigningVars.all { !it.second.isNullOrEmpty() }) {
                val keystoreFile = layout.buildDirectory.file("keystore/release.jks").get().asFile
                keystoreFile.parentFile.mkdirs()
                keystoreFile.writeBytes(Base64.getDecoder().decode(releaseKeystoreBase64))
                storeFile = keystoreFile
                storePassword = releaseSigningVars[1].second
                keyAlias = releaseSigningVars[2].second
                keyPassword = releaseSigningVars[3].second
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            // A review build lives beside the real app instead of on top of it: its own Health
            // Connect permission set, and since the upload names the running package, a
            // reviewer's push cannot land in the source a paired installation writes to (T8.2).
            applicationIdSuffix = ".debug"
        }
    }

    // A resource directory, so the build compiles the generated palette exactly as it compiles
    // res/, without the palette being source.
    sourceSets.getByName("main").res.srcDir(tokensRes)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Periodic background sync (T5.1): the only scheduler in this app. Version lives here,
    // next to the other five, so there is no catalog to drift (root build file, line 1).
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    testImplementation("junit:junit:4.13.2")
}

// afterEvaluate because preBuild is AGP's own task and may be registered after this script runs:
// the hook has to land whether it exists yet or not.
afterEvaluate {
    tasks.named("preBuild") { dependsOn(checkTokensGenerated) }
    // Fail release packaging early when the four variables are absent, whatever entry task was
    // used: without this the build either signs nothing or dies inside AGP with its own
    // vocabulary, and neither tells the owner what to set.
    tasks.configureEach {
        if (name == "validateSigningRelease" || name == "packageRelease") {
            doFirst {
                if (releaseSigningVars.any { it.second.isNullOrEmpty() }) releaseSigningError()
            }
        }
    }
}
