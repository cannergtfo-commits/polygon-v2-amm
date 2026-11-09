plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

dependencies {
    implementation("org.web3j:crypto:4.12.2")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}
