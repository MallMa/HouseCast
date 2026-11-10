plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "io.github.housecast"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.housecast.android"
        // Playback capture (AudioPlaybackCaptureConfiguration) needs Android 10.
        minSdk = 29
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.0-preview"
    }

    signingConfigs {
        // Preview builds are signed with a key committed to the repository so
        // that every CI build can be installed over the previous one. It is
        // not a secret and must never be used for a store release.
        create("preview") {
            storeFile = rootProject.file("preview.keystore")
            storePassword = "housecast-preview"
            keyAlias = "preview"
            keyPassword = "housecast-preview"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("preview")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("preview")
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
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("org.json:json:20240303")
}
