from rest_framework import serializers

from .models import Post, Tag


class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["name"]


class PostSerializer(serializers.ModelSerializer):
    tags = TagSerializer(many=True, read_only=True)
    author_name = serializers.CharField(source="author.name")
    comment_count = serializers.SerializerMethodField()

    class Meta:
        model = Post
        fields = ["title", "tags", "author_name", "comment_count"]

    def get_comment_count(self, obj):
        return obj.comment_set.count()
