#!/bin/sh

# ##########################################################################
#  Gradle start up script for POSIX platform (GitHub Actions / Linux)
# ##########################################################################

# Encontrar el comando de ejecucion de Java provisto por GitHub Actions
if [ -n "$JAVA_HOME" ] ; then
    JAVACMD="$JAVA_HOME/bin/java"
else
    JAVACMD="java"
fi

# Ruta directa hacia el motor empaquetado de Gradle
CLASSPATH="$PWD/gradle/wrapper/gradle-wrapper.jar"

# Ejecutar el compilador pasandole todas las variables nativas limpias
exec "$JAVACMD" -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"
