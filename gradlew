#!/bin/sh

# ##########################################################################
#  Gradle start up script for POSIX platform (GitHub Actions / Linux)
# ##########################################################################

APP_NAME="Gradle"
APP_BASE_NAME=`basename "$0"`

# Use standard directory resolution
PRG="\$0"
while [ -h "\$PRG" ] ; do
    ls=`ls -ld "$PRG"`
    link=`expr "$ls" : '.*-> \(.*\)$'`
    if expr "\$link" : '/.*' > /dev/null; then
        PRG="\$link"
    else
        PRG=`dirname "$PRG"`/"\$link"
    fi
done
APP_HOME=`cd \`dirname "\$PRG"\` >/dev/null; pwd`

CLK_JAR="\$APP_HOME/gradle/wrapper/gradle-wrapper.jar"

# Find Java execution command
if [ -n "\$JAVA_HOME" ] ; then
    JAVACMD="\$JAVA_HOME/bin/java"
else
    JAVACMD="java"
fi

# Execute Gradle Wrapper Main directly
exec "\$JAVACMD" -classpath "\(CLK_JAR" org.gradle.wrapper.GradleWrapperMain "\)@"
