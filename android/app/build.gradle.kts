plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val webProjectDir = rootProject.projectDir.resolve("../../web").canonicalFile
val webDistDir = webProjectDir.resolve("dist")
val generatedWebAssetsDir = layout.buildDirectory.dir("generated/heysureWebAssets")
val npmCommand = if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
    "npm.cmd"
} else {
    "npm"
}

val installWebDependencies by tasks.registering(Exec::class) {
    group = "heysure"
    description = "Installs shared web dependencies when node_modules is absent."
    workingDir = webProjectDir
    commandLine(npmCommand, if (webProjectDir.resolve("package-lock.json").isFile) "ci" else "install")
    onlyIf { !webProjectDir.resolve("node_modules").isDirectory }
}

val buildHeySureWeb by tasks.registering(Exec::class) {
    group = "heysure"
    description = "Builds the shared Vue digital-society console for Android."
    dependsOn(installWebDependencies)
    workingDir = webProjectDir
    commandLine(npmCommand, "run", "build")
    inputs.files(
        webProjectDir.resolve("index.html"),
        webProjectDir.resolve("package.json"),
        webProjectDir.resolve("package-lock.json"),
        webProjectDir.resolve("tsconfig.json"),
        webProjectDir.resolve("vite.config.ts"),
        fileTree(webProjectDir.resolve("src")),
        fileTree(webProjectDir.resolve("game")),
    )
    outputs.dir(webDistDir)
}

val syncHeySureWeb by tasks.registering(Sync::class) {
    group = "heysure"
    description = "Copies the shared web build into generated Android assets."
    dependsOn(buildHeySureWeb)
    from(webDistDir)
    into(generatedWebAssetsDir.map { it.dir("web") })
}

android {
    namespace = "ai.heysure.agent"
    compileSdk = providers.gradleProperty("android.compileSdk")
        .map(String::toInt)
        .orElse(34)
        .get()

    defaultConfig {
        applicationId = "ai.heysure.agent"
        minSdk = 26          // Android 8.0: AccessibilityService.dispatchGesture()
        targetSdk = 34
        versionCode = 1
        versionName = "2.0.0"
    }

    signingConfigs {
        // Optional release keystore — supplied via gradle.properties or env vars so
        // the repo carries no secrets. If absent, release falls back to debug signing
        // (still installable; for store/anti-fraud use, set these and re-sign).
        val storeFilePath = providers.gradleProperty("HEYSURE_RELEASE_STORE_FILE").orNull
            ?: System.getenv("HEYSURE_RELEASE_STORE_FILE")
        if (!storeFilePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(storeFilePath)
                storePassword = (providers.gradleProperty("HEYSURE_RELEASE_STORE_PASSWORD").orNull
                    ?: System.getenv("HEYSURE_RELEASE_STORE_PASSWORD")).orEmpty()
                keyAlias = (providers.gradleProperty("HEYSURE_RELEASE_KEY_ALIAS").orNull
                    ?: System.getenv("HEYSURE_RELEASE_KEY_ALIAS")).orEmpty()
                keyPassword = (providers.gradleProperty("HEYSURE_RELEASE_KEY_PASSWORD").orNull
                    ?: System.getenv("HEYSURE_RELEASE_KEY_PASSWORD")).orEmpty()
            }
        }
    }

    buildTypes {
        release {
            // R8 shrink + obfuscate + resource shrink: smaller APK and fewer
            // Play Protect / anti-fraud false positives. Keep rules in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }

    sourceSets.getByName("main").assets.srcDir(generatedWebAssetsDir)
}

tasks.named("preBuild").configure {
    dependsOn(syncHeySureWeb)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Same Socket.IO protocol the Electron/extension shells speak, so the server
    // needs no separate transport for Android. Exclude the bundled org.json so we
    // use Android's platform one.
    implementation("io.socket:socket.io-client:2.1.0") {
        exclude(group = "org.json", module = "json")
    }

    // WebRTC for human-driven remote control (live screen mirror + input over a
    // peer-to-peer connection). Google archived org.webrtc:google-webrtc; this
    // maintained drop-in keeps the same `org.webrtc` package namespace.
    implementation("io.github.webrtc-sdk:android:125.6422.07")
}
